// The cover-letter batch: select, generate, validate, write. No HTTP, no telemetry —
// split out of index.ts so a test can drive it with a fake client and prove what it
// does NOT do, which is the important half (see "NO STATUS CHANGES" below).
//
// NO STATUS CHANGES, AT ALL. The old version consumed `tailored` rows and walked them
// to `awaiting_approval` as p_agent 'auditor' — racing the real Auditor and stamping a
// verdict the Auditor never gave into an append-only log. A cover letter is a side
// artifact of an application, not a pipeline stage, so this module has no `rpc` in its
// client type: advancing a row is unrepresentable here, not merely avoided.
//
// IDEMPOTENCY KEY: `cover_letter is null`. Written once, the row leaves the queue. That
// is exactly why a bad reply must store NOTHING — a stored bad letter is permanent.

// Untrusted-input fencing and the response schema live in the prompt module.
import { buildCoverLetterPrompt } from "./cover-letter-prompt.ts";
// Separates rows that can be drafted from rows missing what the prompt needs.
import { planCoverLetterBatch, type RawApplicationRow } from "./cover-letter-batch.ts";
// The strict reply-shape check; null means "store nothing".
import { parseCoverLetterReply } from "./parse-letter.ts";
// The master profile supplies identity for the letter header.
import type { MasterProfile } from "../_shared/contracts/shared-types.ts";
// The auditor's pin resolver, reused rather than re-derived so the two agents cannot
// disagree about what a valid pin is; its closed union has no "use the latest" branch.
import { collectPins, resolvePinnedMaster } from "../_shared/audit/pinned-master.ts";

// Every status at which a tailored resume exists and the row has NOT yet reached the human.
// Reading across all three (rather than only `tailored`) means a row the auditor moves on
// before this function runs is not skipped.
// `awaiting_approval` is deliberately EXCLUDED (2026-10-08): the letter write bumps
// updated_at, so a letter landing during review would make the open approval tab report
// "changed elsewhere" (PT409) over an identical diff. Letters are generated before review.
export const COVER_LETTER_STATUSES = ["tailored", "audit_clean", "audit_flagged"] as const;

// Postgres errors as supabase-js reports them; only the message is used.
type DbError = { message: string } | null;

// The exact query chain this module uses — and nothing else. Typed this narrowly so the
// real client and a test fake both satisfy it, and so `rpc` cannot be reached from here.
export interface CoverLetterClient {
  from(table: string): {
    // The queue read.
    select(columns: string): {
      // The status filter.
      in(column: string, values: readonly string[]): {
        // Rows without a tailored resume never enter the batch.
        not(column: string, operator: string, value: null): {
          // The idempotency key.
          is(column: string, value: null): {
            // FIFO, then the batch bound.
            order(column: string, options: { ascending: boolean }): {
              limit(count: number): PromiseLike<{ data: unknown[] | null; error: DbError }>;
            };
          };
        };
      };
    };
    // The one write.
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        is(column: string, value: null): {
          // The status guard: the row must still be at a generating status when written.
          in(column: string, values: readonly string[]): PromiseLike<{ error: DbError }>;
        };
      };
    };
  };
}

// The model call, injected: index.ts adapts the Gemini pool client to this, a test
// returns canned text. `ok:false` carries the transport's reason code.
export type GenerateLetter = (prompt: {
  systemInstruction: string;
  userContent: string;
  responseSchema: Record<string, unknown>;
}) => Promise<{ ok: true; text: unknown } | { ok: false; reason: string }>;

// Loads exactly the given master versions, keyed by version. Injected (instead of one
// `master` argument) because the right master depends on each row's pin, which is only
// known after the queue read. A version absent from the map is reported per row; a
// failed read must THROW, so it fails the run instead of looking like "no such version".
export type LoadMasters = (versions: readonly number[]) => Promise<ReadonlyMap<number, MasterProfile>>;

// The pin the tailor's validator stamped into the resolved resume (validator.ts:776) —
// the same source the auditor reads. Not `applications.master_version`: that column only
// becomes truthful after a migration that has not been pushed.
function pinOf(resume: unknown): unknown {
  // Optional chaining: a missing key yields undefined, which resolves to "unpinned".
  return (resume as { master_version?: unknown } | null)?.master_version;
}

// What a run did, for agent_runs and the HTTP response.
export interface CoverLetterRunResult {
  // Rows the queue read returned.
  readonly rowsIn: number;
  // Letters actually written.
  readonly generated: number;
  // Model calls attempted, successful or not — each one spends quota.
  readonly geminiCalls: number;
  // Rows the planner refused, with why; nothing was spent on them.
  readonly skipped: ReadonlyArray<{ applicationId: string; reason: string }>;
  // Rows that were attempted and wrote nothing, with why.
  readonly failures: ReadonlyArray<{ applicationId: string; error: string }>;
}

// Runs one batch. Throws only if the queue read or the master load fails — that is a
// failed run, and the caller records it; every per-row problem is collected instead.
export async function runCoverLetterBatch(
  // RLS-scoped client.
  db: CoverLetterClient,
  // The model.
  generate: GenerateLetter,
  // Identity for the letter header, by pinned version — never "the newest master",
  // which would put an identity the resume was not tailored from into the letter.
  loadMasters: LoadMasters,
  // Already validated by the caller's resolveBatchSize.
  batchSize: number,
  // Injected so a test can pin the timestamp.
  now: () => Date = () => new Date(),
): Promise<CoverLetterRunResult> {
  // The queue, oldest first so no row waits behind newer ones forever.
  const { data: rows, error } = await db
    .from("applications")
    // Only what the planner and prompt read; job text comes through the FK embed. The
    // `master_version` COLUMN is deliberately not selected: it was never read here, and
    // the pin that is read lives inside `tailored_profile` (see pinOf) — selecting a
    // column that looks like the pin invites the next reader to use the wrong one.
    .select("id, status, tailored_profile, tailor_refs, jobs (title, company_name, description_raw)")
    // See COVER_LETTER_STATUSES.
    .in("status", COVER_LETTER_STATUSES)
    // Excluded in the DATABASE, not by the planner: a row with a null profile skipped after
    // `.limit()` would fill a small batch on every run while real rows starve behind it.
    // (First written for the `awaiting_approval` orphans, which the status list above no
    // longer reads; the guard stays for any generating-status row that lacks a profile.)
    .not("tailored_profile", "is", null)
    // The idempotency key.
    .is("cover_letter", null)
    // FIFO.
    .order("created_at", { ascending: true })
    // Bounds Gemini spend per invocation.
    .limit(batchSize);
  // A failed read is not an empty queue.
  if (error) throw new Error(`queue_unreadable: ${error.message}`);

  // Rows lacking a job title/company are refused before any quota is spent.
  // ponytail: a refused row stays queued and re-read every run; if refusals ever fill a
  // batch, filter jobs.title/company_name in the query above.
  const plan = planCoverLetterBatch((rows ?? []) as RawApplicationRow[]);
  // Distinct, shape-checked pins of the rows that could spend quota; invalid or absent
  // pins are dropped here and reported per row by resolvePinnedMaster below.
  const pins = collectPins(plan.eligible.map((job) => ({ master_version: pinOf(job.resume) })));
  // One load per batch, exactly those versions. Not caught: a failed read is a failed
  // run, never a reason to write letters from some other master.
  const mastersByVersion = await loadMasters(pins);
  // Counters for the result.
  let generated = 0;
  // Every attempt counts, successful or not.
  let geminiCalls = 0;
  // Per-row reasons nothing was written.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Sequential: the key pool is shared and paced.
  for (const job of plan.eligible) {
    try {
      // The master this resume was TAILORED against; anything but `pinned` fails closed.
      const pinned = resolvePinnedMaster(pinOf(job.resume), mastersByVersion);
      // No honest identity source: no letter and no Gemini spend. The row stays queued
      // (cover-letter never moves status), and the reason is named so the run says why.
      if (pinned.kind !== "pinned") {
        // `master_pin_<kind>` mirrors the resolver's own vocabulary, one reason per kind.
        failures.push({ applicationId: job.applicationId, error: `master_pin_${pinned.kind}` });
        // Next row; the rest of the batch is unaffected.
        continue;
      }
      // Fenced prompt; can throw on a malformed stored resume, caught below.
      const prompt = buildCoverLetterPrompt({ master: pinned.master, resume: job.resume, job: job.job });
      // Counted before the await so a thrown transport error is still counted.
      geminiCalls += 1;
      // The model call.
      const outcome = await generate(prompt);
      // Transport failure: store nothing, the row stays queued for the next run.
      if (!outcome.ok) {
        failures.push({ applicationId: job.applicationId, error: `gemini_call_failed: ${outcome.reason}` });
        continue;
      }
      // Strict shape check; null for anything that is not a real letter.
      const letter = parseCoverLetterReply(outcome.text);
      // Off-schema: store nothing — a stored bad letter would never be retried.
      if (letter === null) {
        failures.push({ applicationId: job.applicationId, error: "reply_not_a_cover_letter" });
        continue;
      }
      // The only write. Both columns together, as the database CHECK requires.
      const { error: writeError } = await db
        .from("applications")
        .update({ cover_letter: letter, cover_letter_generated_at: now().toISOString() })
        // This row only.
        .eq("id", job.applicationId)
        // Guarded on the queue predicate, so an overlapping run cannot overwrite a
        // letter written between this run's read and its write.
        .is("cover_letter", null)
        // And on the status: the auditor can move a row to awaiting_approval between this
        // run's read and its write, and a write landing then is the PT409 this list prevents.
        .in("status", COVER_LETTER_STATUSES);
      // A failed write is a failure, not a success with a log line.
      if (writeError) {
        failures.push({ applicationId: job.applicationId, error: writeError.message });
        continue;
      }
      // Landed.
      generated += 1;
    } catch (err) {
      // One bad row must not stop the batch.
      failures.push({ applicationId: job.applicationId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Everything the caller needs for telemetry and the response.
  return { rowsIn: (rows ?? []).length, generated, geminiCalls, skipped: plan.skipped, failures };
}
