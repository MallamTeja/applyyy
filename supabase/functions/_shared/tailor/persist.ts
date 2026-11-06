// PERSISTING A TAILOR VERDICT — the first real writer of `applications.tailored_profile`.
//
// Until this file existed, that column had consumers and no producer: the approval queue
// reads it (`ApprovalQueuePage.tsx:223`) and nothing anywhere filled it. That is why the
// queue is empty by construction rather than merely idle.
//
// THE ORDERING RULE, which is the whole design: THE STATUS IS A CLAIM THAT THE PAYLOAD
// EXISTS. Write the profile first, advance the status second, and never advance if the
// write failed. The reverse order opens a window where a row sits at `tailored` with a
// null profile — the exact state the approval gate was built to refuse, manufactured by
// the trusted side instead of by a missing agent. Ordering makes that unrepresentable
// rather than merely unlikely, which is §5's "a comment is not a control".
//
// WHY THE STATUS MOVES THROUGH THE RPC AND NEVER A BARE UPDATE: the guard trigger
// refuses an anonymous status change with SQLSTATE 42501
// (`status_transition_guard.sql:209-215`). `advance_application_status` is what sets
// `applyy.acting_agent` for the transaction, so it is the only sanctioned route.
//
// AND WHY THE PROFILE WRITE IS A BARE UPDATE, which looks inconsistent and is not: the
// same guard short-circuits at `:199` — `if new.status is not distinct from old.status
// then return new` — and its own comment names this case, "an agent writing a score or a
// storage path". A payload-only update is the cheap, intended path.

// The verdict this module persists. Imported rather than re-described, so a new outcome
// kind is a compile error here instead of a silently unhandled branch.
import type { TailorOutcome } from "./tailorer.ts";

// The database surface this module needs, and nothing more.
//
// NARROW ON PURPOSE, mirroring `../screen/supabase-queries.ts`'s `SelectableClient`: a
// seam typed to the full postgrest client would drag its whole surface into every test
// and let a future edit reach for a method this module was never meant to call.
export interface TailorPersistClient {
  // The payload write. Chained exactly as postgrest builds it.
  from(table: string): {
    update(values: Record<string, unknown>): {
      // Returns the error as DATA, the way postgrest does — never throws.
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
  // The status move, through the guarded function.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

// What the caller learns. A union rather than a thrown error, because a persistence
// failure is an operational fact the CLI has to report and retry against, not an
// exception that should unwind a batch of otherwise-successful jobs.
export type PersistOutcome =
  // The row is now at the named status, and any payload it implies is already written.
  | { readonly ok: true; readonly status: "tailored" | "failed" }
  // Nothing further was attempted. The message carries postgrest's own text.
  | { readonly ok: false; readonly message: string };

// The closed set of reasons a tailor fails an application for (2026-11-05). Written to
// applications.failure_reason BEFORE the move, the way the matcher (fail-exit.ts) and the screener
// (persist-verdict.ts) do it: log_status_change copies the column into the status_change event, and
// until today every tailor failure left it NULL (22 live rows), with the cause only in a note.
export type TailorFailureReason = "tailor_validation_failed" | "tailor_input_unusable";

/* Fails one application for the tailor: failure_reason first, then the guarded move, whose detail
   carries the same code plus the specifics. Never moves if the reason could not be written, so a
   failed row always says why. Used by the refusal below and by index.ts's unusable-input skip. */
export async function failTailorApplication(
  client: TailorPersistClient,
  applicationId: string,
  reason: TailorFailureReason,
  detail: Record<string, unknown>,
): Promise<PersistOutcome> {
  // The reason, as a payload-only update (the guard lets a same-status write through).
  const write = await client.from("applications").update({ failure_reason: reason }).eq("id", applicationId);
  // No reason, no move: the row stays at scored and the caller reports the failure.
  if (write.error) return { ok: false, message: write.error.message };
  // `scored -> failed` is legal for the tailor (`status_transition_guard.sql:118`).
  const { error } = await client.rpc("advance_application_status", {
    p_application_id: applicationId,
    p_to_status: "failed",
    p_agent: "tailor",
    // The code first, then what made it, structured so a UI can branch on it.
    p_detail: { reason, ...detail },
  });
  // Carried through rather than absorbed, so a caller can tell "failed cleanly" from
  // "could not even record the failure".
  if (error) return { ok: false, message: error.message };
  // Failed, with its reason on the row and in the event.
  return { ok: true, status: "failed" };
}

// Persist one verdict against one application row.
export async function persistTailorOutcome(
  client: TailorPersistClient,
  applicationId: string,
  outcome: TailorOutcome,
): Promise<PersistOutcome> {
  // A refusal has no payload to write, so it is a single guarded status move. Handled
  // first because the happy path below depends on having a resume at all.
  if (outcome.kind === "refused") {
    // `scored -> failed` is legal for the tailor (`status_transition_guard.sql:118`).
    // The violations travel in the event detail: they are the dashboard's content, and
    // `validator.ts:70` requires they survive as data rather than as a stack trace.
    // Since 2026-11-05 through failTailorApplication, so failure_reason is written first. The violations
    // stay structured, not flattened to a string — a UI branches on `kind`.
    // A retry, when one ran (2026-11-05), is recorded beside the final violations: the first attempt and how it ended.
    return failTailorApplication(client, applicationId, "tailor_validation_failed", outcome.retry === null
      // No retry: the event exactly as before.
      ? { violations: outcome.violations }
      // A retry ran: the final verdict, the first one, and how the retry ended.
      : { violations: outcome.violations, first_attempt_violations: outcome.retry.firstViolations, retry: outcome.retry.result });
  }

  // THE PAYLOAD, FIRST. See the header: the status that follows is a claim this line
  // succeeded, so it must actually have succeeded before the claim is made.
  const write = await client.from("applications")
    // `tailor_refs` rides in the SAME statement as the profile: a second write could fail
    // alone and leave a `tailored` row whose refs the Auditor never sees. The column is
    // `tailor_refs jsonb` (core_tables.sql:351), read by audit/detector.ts:503.
    // `selected_jd_keywords` rides along for the same reason (2026-10-06): it is the
    // denominator of the approval page's ATS coverage, so a resume written without it
    // reads 0%. Copied to a plain array because the column is `text[]` and the outcome's
    // list is readonly.
    // `master_version` too (2026-10-08): the column was never written, so its FK to
    // master_profiles guarded nothing and every reader had to dig the pin out of JSON.
    // It is the validator-stamped pin (validator.ts:776), in the same statement so the
    // column can never disagree with the resume it mirrors.
    // `cover_letter` + `cover_letter_generated_at` are CLEARED here (2026-10-24): a letter
    // quotes the tailored_profile it was built from and is write-once (`cover-letter/run.ts`
    // queues only `cover_letter is null`), so a new profile keeping an old letter would be a
    // stale letter nothing can flag — the approval page's notice keys on edits against the
    // NEW tailor original, which reads 0. Cleared in the SAME statement (the pair's CHECK
    // `applications_cover_letter_consistent` requires both-null or both-set, and a separate
    // write could fail alone). Today this is a no-op — the tailor's only edge is
    // scored -> tailored, where no letter exists yet — it becomes load-bearing the day the
    // audit_flagged -> tailored re-tailor lane (humanLanes.ts, affordance_only) is wired.
    .update({ tailored_profile: outcome.resume, tailor_refs: outcome.refs, selected_jd_keywords: [...outcome.jdKeywords], master_version: outcome.resume.master_version, cover_letter: null, cover_letter_generated_at: null })
    // Scoped to one row. Without this predicate the update would rewrite every
    // application the caller's RLS context can see.
    .eq("id", applicationId);

  // STOP HERE ON FAILURE. Advancing anyway would put a row at `tailored` with a null
  // profile — the one state this module exists to make impossible.
  if (write.error) return { ok: false, message: write.error.message };

  // Only now is the claim true. `scored -> tailored`, the Tailor's one legal edge
  // (`status_transition_guard.sql:116`).
  const { error } = await client.rpc("advance_application_status", {
    p_application_id: applicationId,
    p_to_status: "tailored",
    p_agent: "tailor",
    // Enough to reconstruct what was written without re-reading the row; a dedupe the tailorer made is
    // named here (2026-11-05), so a prompt that repeats refs is visible rather than silently repaired.
    // The retry, when one ran (2026-11-05), so the rewrite's yield can be measured from the events.
    p_detail: {
      // The success code, as before.
      reason: "tailored_profile_written",
      // Only when the tailorer dropped a repeated ref.
      ...(outcome.dedupedRefs.length > 0 ? { deduplicated_refs: outcome.dedupedRefs } : {}),
      // Only when the skills shape (2026-11-06) topped up or dropped a group, so neither is silent.
      ...(outcome.skillsAdded.length > 0 ? { skills_floor_added: outcome.skillsAdded } : {}),
      // The model picks removed because their group is irrelevant to the posting.
      ...(outcome.skillsDropped.length > 0 ? { skills_groups_dropped: outcome.skillsDropped } : {}),
      // Only when the one-shot rewrite ran.
      ...(outcome.retry !== null ? { retry: { first_attempt_violations: outcome.retry.firstViolations, rewritten_refs: outcome.retry.rewrittenRefs } } : {}),
    },
  });
  // A failure here leaves the profile written and the status unmoved — recoverable by
  // re-running, and deliberately preferred over the inverse, which is not.
  if (error) return { ok: false, message: error.message };

  return { ok: true, status: "tailored" };
}
