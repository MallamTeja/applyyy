// Matcher pre-gate: stage 0 (the tech gate) re-applied to a passed_filters row BEFORE the
// matcher spends a Gemini call on it.
//
// WHY THIS EXISTS (Teja, 2026-10-09, option (d)): until that ruling, the screener passed any
// title matching no configured title or keyword. 6636 of 6662 passed_filters rows (99.6%)
// got there that way, about 3155 of them non-engineering. The screener now drops those, but
// the rows already waiting would otherwise each cost one Gemini call. The matcher owns the
// legal edge passed_filters -> dropped_filter, so it prunes them itself as it consumes the
// queue, at zero Gemini cost and with no one-off bulk write. It also applies the user's
// CURRENT config, so widening the lists re-judges the backlog without any re-screen.
//
// SAME FUNCTION, NOT A COPY: the verdict comes from `screenTechRole`, the one the screener
// and scout paths use, so the two stages cannot drift apart.
//
// SAME WRITE PATH: a drop goes through writeMatchScore (guarded on status = passed_filters,
// returning the stamp) and advanceScoredRow (stamp-guarded RPC, PT409 -> skipped_stale), so
// a pre-gate drop has exactly the race protection a score does.

// The single shared verdict function, plus its config type and drop codes.
import { screenTechRole, type TechGateDropCode, type TechGatePreferences } from "../_shared/screen/tech-gate.ts";
// The guarded write and the guarded move, reused rather than rebuilt.
import { advanceScoredRow, writeMatchScore, type MatchScoreClient } from "./write-score.ts";

// What happened to one row at the gate. Closed: the wrapped scorer runs ONLY on `continue`.
export type PreGateOutcome =
  // The gate has no objection; the row goes on to Gemini scoring.
  | { readonly kind: "continue" }
  // Rejected by stage 0 and moved to dropped_filter by this run.
  | { readonly kind: "dropped"; readonly code: TechGateDropCode; readonly reason: string }
  // Another run moved or wrote the row first; nothing was done here.
  | { readonly kind: "skipped_stale" }
  // The drop write or move failed; the row stays at passed_filters for the next run.
  | { readonly kind: "error"; readonly message: string };

// The fields of one posting the gate reads.
export interface PreGateJob {
  // The posting title.
  readonly title: string;
  // The raw body; the gate reads only its first 300 characters.
  readonly descriptionRaw: string | null;
}

// Run the gate on one row and, if it rejects, drop the row through the matcher's own edge.
export async function preGateRow(
  // The app-user client (RLS applies), or a fake in tests.
  db: MatchScoreClient,
  // The passed_filters row to judge.
  applicationId: string,
  // Title and body of its job; null when the embedded job row is missing.
  job: PreGateJob | null,
  // The user's CURRENT search_preferences, mapped by toTechGatePreferences.
  preferences: TechGatePreferences,
): Promise<PreGateOutcome> {
  // A missing job is missing DATA, not an empty title: judged as "", it would be dropped as
  // tech_gate_unclassified, turning an absence into an answer (CLAUDE.md §6). Report it and
  // leave the row where it is, as the screener does for the same case.
  if (job === null) return { kind: "error", message: "pre-gate: job row missing for this application" };
  // The exact verdict the screener would give this posting today.
  const verdict = screenTechRole(job.title, job.descriptionRaw, preferences);
  // No objection (recognised, or an empty config that passes with a warning): score it.
  if (!verdict.drop) return { kind: "continue" };

  // STEP 1, the payload: drop_reason carries the gate's code, as the screener writes it.
  // match_score and match_reasoning are CLEARED, not left alone: if an overlapping run's
  // score write landed first, this drop wins the stamp race and would otherwise leave that
  // run's score sitting on a row dropped by the gate.
  const written = await writeMatchScore(db, applicationId, { drop_reason: verdict.code, match_score: null, match_reasoning: null });
  // A real write failure stays a failure; the row is untouched for the next run.
  if (written.kind === "error") return { kind: "error", message: written.message };
  // Another run already moved this row; it is not ours to drop.
  if (written.kind === "skipped_stale") return { kind: "skipped_stale" };

  // STEP 2, the move, on the stamp of our own write.
  const moved = await advanceScoredRow(
    db,
    // The row we just wrote.
    applicationId,
    // The matcher's legal drop edge out of passed_filters.
    "dropped_filter",
    // The event says which stage dropped it and why, mirroring the drop_reason column.
    { reason: verdict.code, stage: "matcher_pre_gate", detail: verdict.reason },
    // Only a row nobody has written since our step 1 may be moved.
    written.updatedAt,
  );
  // A refused stale stamp: another run wrote the row after us, so the move is its to make.
  if (moved.kind === "skipped_stale") return { kind: "skipped_stale" };
  // Any other failure is reported against the row.
  if (moved.kind === "error") return { kind: "error", message: moved.message };
  // Dropped, with zero Gemini calls spent on it.
  return { kind: "dropped", code: verdict.code, reason: verdict.reason };
}

// Wrap the matcher's per-row scorer so the gate runs first and the scorer — the only code
// that calls Gemini — is reached ONLY for rows the gate lets through. Built as a wrapper,
// not an `if` inside the scorer, so "no Gemini call for a dropped row" is a property of the
// call graph that a test can check with a spy, not a convention a later edit can break.
export function withTechPreGate<R extends { readonly id: string }, C>(
  // The client used for a pre-gate drop.
  db: MatchScoreClient,
  // The user's current config.
  preferences: TechGatePreferences,
  // How to read title/body from a queue row, whose embedded job shape is the caller's; null
  // when the embed is missing, which preGateRow reports as an error rather than judging "".
  readJob: (row: R) => PreGateJob | null,
  // Told about every row the gate handled itself, so the caller can count it.
  onGated: (row: R, outcome: Exclude<PreGateOutcome, { kind: "continue" }>) => void,
  // The real scorer; never called for a row the gate dropped, skipped or failed.
  score: (row: R, call: C) => Promise<void>,
): (row: R, call: C) => Promise<void> {
  return async (row, call) => {
    // Judge and, if rejected, drop — before anything that could spend a Gemini call. Any
    // throw (e.g. a null element inside a text[] config column reaching `.trim()`) becomes
    // this row's error: the gate sits OUTSIDE the scorer's per-row try/catch, and
    // runBatchWithDeadline has none, so an escaped throw would 500 the whole run and leave
    // its agent_runs row stuck at `running`.
    let outcome: PreGateOutcome;
    try {
      // The normal path; supabase-js failures come back as values, not throws.
      outcome = await preGateRow(db, row.id, readJob(row), preferences);
    } catch (err) {
      // Contained to this row; the scorer is not reached and the batch carries on.
      outcome = { kind: "error", message: `pre-gate threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Through the gate: hand the row to the scorer unchanged.
    if (outcome.kind === "continue") return await score(row, call);
    // Handled here; the scorer is not reached.
    onGated(row, outcome);
  };
}
