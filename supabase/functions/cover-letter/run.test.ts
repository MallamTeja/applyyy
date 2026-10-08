// Tests for the cover-letter rewrite: the reply-shape validator, and the batch's
// write discipline proved against a recording fake client. No network, no database.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Units under test.
import { MIN_LETTER_WORDS, parseCoverLetterReply } from "./parse-letter.ts";
import { COVER_LETTER_STATUSES, runCoverLetterBatch, type CoverLetterClient, type GenerateLetter, type LoadMasters } from "./run.ts";
// The real profile type, so the per-version fixtures below are checked against the contract.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";

// A letter long enough to pass the word floor.
const LETTER = Array.from({ length: MIN_LETTER_WORDS + 10 }, (_, i) => `word${i}`).join(" ");

test("validator: a schema-conforming reply returns the trimmed letter", () => {
  // The happy path, or the validator is just a wall.
  assert.equal(parseCoverLetterReply(JSON.stringify({ coverLetter: `  ${LETTER}\n` })), LETTER);
});

test("validator: every off-schema reply is null, never stored", () => {
  // Each case is something the old `catch {}` would have saved as the letter.
  const bad: unknown[] = [
    // Plain prose — the old fallback stored this verbatim.
    "Sure! Here is your cover letter: Dear team...",
    // Valid JSON, wrong top-level shapes.
    "null",
    "[]",
    JSON.stringify(LETTER),
    // Right shape, wrong field type or name.
    JSON.stringify({ coverLetter: 42 }),
    JSON.stringify({ cover_letter: LETTER }),
    // Blank and too short.
    JSON.stringify({ coverLetter: "   " }),
    JSON.stringify({ coverLetter: "Dear team, hire me." }),
    // A missing text part from the transport.
    undefined,
  ];
  // One assertion per case, so a failure names it.
  for (const reply of bad) assert.equal(parseCoverLetterReply(reply), null, `accepted: ${String(reply)}`);
});

// Builds one eligible queue row. The pin lives INSIDE tailored_profile, where the tailor's
// validator stamps it — that is the field the batch must read, so the fixture carries it
// there and nowhere else (no top-level `master_version`: the query no longer selects it).
function row(id: string, pin: unknown) {
  // Same shape as a real queue row: tailored profile present, job title and company present.
  return {
    // Distinct ids so failures and writes can be attributed per row.
    id,
    // Any of the four queue statuses; the batch never looks at it.
    status: "tailored",
    // `master_version` is the pin under test; `undefined` is spread out so "unpinned" is real absence.
    tailored_profile: { experience: [{ role: "Engineer", company: "Acme", bullets: [{ text: "Built X" }] }], skills: [{ name: "Go" }], ...(pin === undefined ? {} : { master_version: pin }) },
    // Unused by the prompt.
    tailor_refs: null,
    // The FK embed the planner needs for eligibility.
    jobs: { title: "Backend Engineer", company_name: "Initech", description_raw: "Build APIs." },
  };
}
// The default single row, pinned to version 1 — the existing tests' fixture.
const ROW = row("app-1", 1);

// A fake client that records every call, INCLUDING an `rpc` the module must never use.
// `rows` lets a test choose what the queue read returns; defaults to the one-row queue.
function recordingClient(rows: unknown[] = [ROW]) {
  // Observations for the assertions.
  const calls = { rpc: [] as unknown[], updates: [] as Array<{ values: Record<string, unknown>; filters: unknown[] }>, queue: [] as unknown[] };
  // The fake; the `rpc` key is extra on purpose — present, so a call would be caught.
  const client = {
    // Recorded so the test can fail if the module ever reaches for it.
    rpc: (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args });
      return Promise.resolve({ error: null });
    },
    // Every table read or write goes through here.
    from: (_table: string) => ({
      // The queue read: records its filters and returns one row.
      select: (_cols: string) => ({
        // Each link captures its arguments for the final record.
        in: (col: string, vals: readonly string[]) => ({
          // The null-profile exclusion.
          not: (c2: string, op: string, v2: null) => ({
            // The idempotency key.
            is: (c3: string, v3: null) => ({
              // Order is not asserted; only filters and the bound are.
              order: (_c: string, _o: { ascending: boolean }) => ({
                // The terminal link: record everything, return the one row.
                limit: (n: number) => {
                  // One record per queue read.
                  calls.queue.push({ in: [col, vals], not: [c2, op, v2], is: [c3, v3], limit: n });
                  // A successful read.
                  return Promise.resolve({ data: rows, error: null });
                },
              }),
            }),
          }),
        }),
      }),
      // The write: records the payload and its filters.
      update: (values: Record<string, unknown>) => ({
        // The row filter.
        eq: (c: string, v: string) => ({
          // The overwrite guard; terminal link.
          is: (c2: string, v2: null) => {
            // One record per write, with both filters.
            calls.updates.push({ values, filters: [[c, v], [c2, v2]] });
            // A successful write.
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };
  // Typed as the module's client; the extra `rpc` key is invisible to it.
  return { calls, client: client as CoverLetterClient };
}

// A minimal master profile per version; only identity is read. Each version carries a
// DISTINCT name so a prompt proves which master built it.
function masterNamed(fullName: string): MasterProfile {
  // Cast: the prompt reads identity only, and a full profile would bury what is under test.
  return { identity: { full_name: fullName, email: "t@example.com" } } as unknown as MasterProfile;
}
// Version 1 — the pin ROW carries.
const MASTER = masterNamed("Teja V1");

// A loader that serves exactly the given versions and records every call, so a test can
// assert both what was asked for and how often.
function recordingLoader(byVersion: Record<number, MasterProfile> = { 1: MASTER }) {
  // One entry per call, holding the pins requested.
  const loads: number[][] = [];
  // The seam run.ts calls; returns only versions it was asked for AND has, like the real `.in()`.
  const load: LoadMasters = (versions) => {
    // Copied, so a later mutation by the caller cannot rewrite the record.
    loads.push([...versions]);
    // Exact-version map; a missing version is simply absent, as in the database.
    return Promise.resolve(new Map(versions.filter((v) => v in byVersion).map((v) => [v, byVersion[v]!] as const)));
  };
  // Both, so tests can pass `load` and inspect `loads`.
  return { load, loads };
}
// A model that captures each prompt and answers with a valid letter.
function capturingModel() {
  // Every prompt the batch sent, in order.
  const prompts: Array<Parameters<GenerateLetter>[0]> = [];
  // The seam; always a good reply so only the master choice varies.
  const generate: GenerateLetter = (prompt) => {
    // Recorded before replying so a thrown reply would still be visible.
    prompts.push(prompt);
    // A schema-conforming letter.
    return Promise.resolve({ ok: true, text: JSON.stringify({ coverLetter: LETTER }) });
  };
  // Both, for assertions.
  return { prompts, generate };
}
// A fixed clock so the stored timestamp is assertable.
const NOW = () => new Date("2026-10-04T00:00:00.000Z");

test("batch: a good reply writes ONLY the two cover-letter columns and makes no RPC call", async () => {
  // Fresh recorder.
  const { calls, client } = recordingClient();
  // The model returns a valid letter.
  const generate: GenerateLetter = () => Promise.resolve({ ok: true, text: JSON.stringify({ coverLetter: LETTER }) });
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, recordingLoader().load, 5, NOW);
  // The central claim: no status RPC, ever.
  assert.equal(calls.rpc.length, 0);
  // Exactly the two columns — no status, no block_detail, no audit_findings.
  assert.deepEqual(calls.updates, [
    { values: { cover_letter: LETTER, cover_letter_generated_at: "2026-10-04T00:00:00.000Z" }, filters: [["id", "app-1"], ["cover_letter", null]] },
  ]);
  // The queue spans all four pre-approval statuses and excludes rows already lettered.
  assert.deepEqual(calls.queue, [
    { in: ["status", COVER_LETTER_STATUSES], not: ["tailored_profile", "is", null], is: ["cover_letter", null], limit: 5 },
  ]);
  // Counters agree with what happened.
  assert.equal(result.generated, 1);
  // One model call spent.
  assert.equal(result.geminiCalls, 1);
});

test("batch: a malformed reply or a transport failure stores NOTHING and is counted", async () => {
  // Two failure modes, same required outcome.
  const replies: Array<Awaited<ReturnType<GenerateLetter>>> = [
    // The old code saved this text as the letter.
    { ok: true, text: "Sure! Here is your cover letter." },
    // Key pool exhausted.
    { ok: false, reason: "all_keys_cooling" },
  ];
  // Each mode in isolation.
  for (const reply of replies) {
    // Fresh recorder per mode.
    const { calls, client } = recordingClient();
    // Run with the canned reply.
    const result = await runCoverLetterBatch(client, () => Promise.resolve(reply), recordingLoader().load, 5, NOW);
    // No write at all, so the row stays queued and the next run retries.
    assert.equal(calls.updates.length, 0);
    // And still no RPC.
    assert.equal(calls.rpc.length, 0);
    // Counted as a failure, not silently dropped.
    assert.equal(result.failures.length, 1);
    // Nothing generated.
    assert.equal(result.generated, 0);
  }
});

test("pin: each row's letter is built from the master version IT was tailored against", async () => {
  // Two rows tailored against different masters — the newest-master bug would name V2 in both.
  const { calls, client } = recordingClient([row("app-v1", 1), row("app-v2", 2)]);
  // Both versions available, each with a distinct identity.
  const { load } = recordingLoader({ 1: masterNamed("Teja V1"), 2: masterNamed("Teja V2") });
  // Captures prompts so identity is checkable per row.
  const { prompts, generate } = capturingModel();
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, load, 5, NOW);
  // Both letters landed; the failures are printed if not, so a red run says why.
  assert.equal(result.generated, 2, JSON.stringify(result.failures));
  // FIFO order is preserved, so prompt[0] is app-v1's and prompt[1] is app-v2's.
  assert.equal(prompts.length, 2);
  // app-v1 names its own master...
  assert.match(prompts[0]!.systemInstruction, /Teja V1/);
  // ...and never the other one.
  assert.doesNotMatch(prompts[0]!.systemInstruction, /Teja V2/);
  // app-v2 names its own master...
  assert.match(prompts[1]!.systemInstruction, /Teja V2/);
  // ...and never the other one.
  assert.doesNotMatch(prompts[1]!.systemInstruction, /Teja V1/);
  // Writes went to both rows, in order.
  assert.deepEqual(calls.updates.map((u) => u.filters[0]), [["id", "app-v1"], ["id", "app-v2"]]);
});

test("pin: an unpinned row gets no model call and fails closed; other rows are unaffected", async () => {
  // `undefined` = no master_version key at all, `null` = explicit null; app-ok is pinned normally.
  const { calls, client } = recordingClient([row("app-none", undefined), row("app-null", null), row("app-ok", 1)]);
  // Only version 1 exists; there is nothing to "fall back" to except a wrong answer.
  const { load } = recordingLoader();
  // Captures prompts so we can count model calls per row.
  const { prompts, generate } = capturingModel();
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, load, 5, NOW);
  // Exactly one model call — for the pinned row.
  assert.equal(prompts.length, 1);
  // The spend counter agrees: refused rows cost nothing.
  assert.equal(result.geminiCalls, 1);
  // Both unpinned shapes fail with the resolver's reason, named.
  assert.deepEqual(result.failures, [
    { applicationId: "app-none", error: "master_pin_unpinned" },
    { applicationId: "app-null", error: "master_pin_unpinned" },
  ]);
  // Only the pinned row was written.
  assert.deepEqual(calls.updates.map((u) => u.filters[0]), [["id", "app-ok"]]);
  // And it still landed.
  assert.equal(result.generated, 1);
});

test("pin: a pin the loader did not return is pinned_version_missing, with no model call", async () => {
  // Pinned to 7, which the loader does not have — version 1 must NOT be substituted.
  const { calls, client } = recordingClient([row("app-7", 7)]);
  // Only version 1 exists.
  const { load } = recordingLoader();
  // Captures prompts so we can prove none was sent.
  const { prompts, generate } = capturingModel();
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, load, 5, NOW);
  // No spend on a row with no honest master.
  assert.equal(prompts.length, 0);
  // Named reason, distinct from unpinned.
  assert.deepEqual(result.failures, [{ applicationId: "app-7", error: "master_pin_pinned_version_missing" }]);
  // Nothing written; the row stays queued.
  assert.equal(calls.updates.length, 0);
});

test("pin: an invalid pin shape fails closed as invalid_pin", async () => {
  // A string "1" — the lenient-parser trap; Number("1") would quietly accept it.
  const { client } = recordingClient([row("app-str", "1")]);
  // Captures prompts so we can prove none was sent.
  const { prompts, generate } = capturingModel();
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, recordingLoader().load, 5, NOW);
  // No spend.
  assert.equal(prompts.length, 0);
  // Named reason.
  assert.deepEqual(result.failures, [{ applicationId: "app-str", error: "master_pin_invalid_pin" }]);
});

test("pin: the loader is called once per batch with exactly the distinct sorted pins", async () => {
  // Out of order, duplicated, plus an unpinned and an invalid pin that must not be requested.
  const { client } = recordingClient([row("a", 3), row("b", 1), row("c", 3), row("d", null), row("e", "2")]);
  // Records the request.
  const { load, loads } = recordingLoader({ 1: masterNamed("V1"), 3: masterNamed("V3") });
  // Run one batch.
  await runCoverLetterBatch(client, capturingModel().generate, load, 5, NOW);
  // One call, distinct valid pins, ascending.
  assert.deepEqual(loads, [[1, 3]]);
});

test("pin: a loader failure fails the run rather than writing letters from another master", async () => {
  // A normal pinned row.
  const { calls, client } = recordingClient();
  // The loader's read failed; index.ts maps this throw to 503 master_profile_unreadable.
  const load: LoadMasters = () => Promise.reject(new Error("boom"));
  // Captures prompts so we can prove none was sent.
  const { prompts, generate } = capturingModel();
  // The throw propagates — it is a failed run, not a per-row failure.
  await assert.rejects(runCoverLetterBatch(client, generate, load, 5, NOW), /boom/);
  // Nothing spent...
  assert.equal(prompts.length, 0);
  // ...and nothing written.
  assert.equal(calls.updates.length, 0);
});
