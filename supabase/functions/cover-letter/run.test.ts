// Tests for the cover-letter rewrite: the reply-shape validator, and the batch's
// write discipline proved against a recording fake client. No network, no database.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Units under test.
import { MIN_LETTER_WORDS, parseCoverLetterReply } from "./parse-letter.ts";
import { COVER_LETTER_STATUSES, runCoverLetterBatch, type CoverLetterClient, type GenerateLetter } from "./run.ts";

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

// One eligible queue row: tailored profile present, job title and company present.
const ROW = {
  id: "app-1",
  status: "tailored",
  tailored_profile: { experience: [{ role: "Engineer", company: "Acme", bullets: [{ text: "Built X" }] }], skills: [{ name: "Go" }] },
  tailor_refs: null,
  master_version: 1,
  jobs: { title: "Backend Engineer", company_name: "Initech", description_raw: "Build APIs." },
};

// A fake client that records every call, INCLUDING an `rpc` the module must never use.
function recordingClient() {
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
                  return Promise.resolve({ data: [ROW], error: null });
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

// A minimal master profile; only identity is read.
const MASTER = { identity: { full_name: "Teja", email: "t@example.com" } } as never;
// A fixed clock so the stored timestamp is assertable.
const NOW = () => new Date("2026-10-04T00:00:00.000Z");

test("batch: a good reply writes ONLY the two cover-letter columns and makes no RPC call", async () => {
  // Fresh recorder.
  const { calls, client } = recordingClient();
  // The model returns a valid letter.
  const generate: GenerateLetter = () => Promise.resolve({ ok: true, text: JSON.stringify({ coverLetter: LETTER }) });
  // Run one batch.
  const result = await runCoverLetterBatch(client, generate, MASTER, 5, NOW);
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
    const result = await runCoverLetterBatch(client, () => Promise.resolve(reply), MASTER, 5, NOW);
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
