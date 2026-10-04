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

// Every status at which a tailored resume exists and nothing has been sent yet. A letter
// is useful from `tailored` until a human approves; reading across all four (rather than
// only `tailored`) means a row that moves on before this function runs is not skipped.
export const COVER_LETTER_STATUSES = ["tailored", "audit_clean", "audit_flagged", "awaiting_approval"] as const;

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
        is(column: string, value: null): PromiseLike<{ error: DbError }>;
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

// Runs one batch. Throws only if the queue read fails — that is a failed run, and the
// caller records it; every per-row problem is collected instead.
export async function runCoverLetterBatch(
  // RLS-scoped client.
  db: CoverLetterClient,
  // The model.
  generate: GenerateLetter,
  // Identity for the letter header.
  master: MasterProfile,
  // Already validated by the caller's resolveBatchSize.
  batchSize: number,
  // Injected so a test can pin the timestamp.
  now: () => Date = () => new Date(),
): Promise<CoverLetterRunResult> {
  // The queue, oldest first so no row waits behind newer ones forever.
  const { data: rows, error } = await db
    .from("applications")
    // Only what the planner and prompt read; job text comes through the FK embed.
    .select("id, status, tailored_profile, tailor_refs, master_version, jobs (title, company_name, description_raw)")
    // See COVER_LETTER_STATUSES.
    .in("status", COVER_LETTER_STATUSES)
    // Excluded in the DATABASE, not by the planner: the three live `awaiting_approval`
    // orphans have a null profile, and skipping them after `.limit()` would let them
    // fill a small batch on every run while real rows starve behind them.
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
  // Counters for the result.
  let generated = 0;
  // Every attempt counts, successful or not.
  let geminiCalls = 0;
  // Per-row reasons nothing was written.
  const failures: Array<{ applicationId: string; error: string }> = [];

  // Sequential: the key pool is shared and paced.
  for (const job of plan.eligible) {
    try {
      // Fenced prompt; can throw on a malformed stored resume, caught below.
      const prompt = buildCoverLetterPrompt({ master, resume: job.resume, job: job.job });
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
        .is("cover_letter", null);
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
