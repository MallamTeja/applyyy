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

// --- pre-gate-only sweep mode (Teja, 2026-10-09: one-off sweep of the unscored backlog) ----
//
// WHY A MODE, NOT A SQL STATEMENT: the gate's matching rules (conditional word boundaries,
// title-only title terms, the 300-char description head, blank skipping) live in
// screenTechRole. A SQL sweep would be a second hand-written copy that drifts. This mode runs
// the SAME preGateRow over the backlog and simply never scores: a row the gate passes is left
// at passed_filters, untouched, for a normal run to score later.

// How the matcher treats a row the gate lets through. Closed: there is no third behaviour.
export type MatcherMode =
  // Normal run: gate, then score with Gemini.
  | { readonly kind: "score" }
  // Sweep: gate only; survivors are counted and left in place, Gemini is never called.
  | { readonly kind: "pregate_only" };

// The sweep moves rows with no Gemini call each, so it may take far more than the scoring
// cap of 25 per run: ~2 DB round-trips per row fits ~500 in the 120 s deadline.
export const PREGATE_ONLY_MAX_BATCH = 500;

// Classify `?mode=`. Absent is a normal run; anything other than the one known value is a
// refusal, never a silent fall-back to scoring (a typo must not spend Gemini quota).
export function parseMatcherMode(params: URLSearchParams): MatcherMode | { readonly kind: "invalid" } {
  // null only when the key is missing; "" is present-but-wrong.
  const raw = params.get("mode");
  // No mode asked for: the unchanged normal run.
  if (raw === null) return { kind: "score" };
  // The one sweep spelling.
  if (raw === "pregate_only") return { kind: "pregate_only" };
  // Anything else, including "", is refused by the caller with a 400.
  return { kind: "invalid" };
}

// Pick the per-row handler the gate hands survivors to. In sweep mode it is a counter that
// can NEVER reach the scorer — the scorer is the only code that calls Gemini — so "a sweep
// spends no quota" is a property of this function, checked by a spy in the tests.
export function selectScorer<R, C>(
  // Which run this is.
  mode: MatcherMode,
  // The real Gemini scorer.
  score: (row: R, call: C) => Promise<void>,
  // Told about each row the gate passed during a sweep, so the run can report the count.
  onSurvivor: (row: R) => void,
): (row: R, call: C) => Promise<void> {
  // Normal run: the real scorer, unchanged.
  if (mode.kind === "score") return score;
  // Sweep: count the survivor and leave the row exactly as it was.
  return async (row) => {
    onSurvivor(row);
  };
}

// THE SWEEP CURSOR, pure so its one dangerous answer is tested. "Done" must never be claimed
// while rows are unjudged — an operator loop that stops early would leave the backlog half
// swept and believe it finished. So it is computed from what was PROCESSED, not what was read:
//   - stopped early (deadline): resume after the last processed row, or where this page
//     began if none was; never done, since the unreached rows are still unjudged;
//   - a full page, all processed: resume after its last row; not done, more may follow;
//   - a short page, all processed: done, nothing follows.
export function nextSweepCursor(page: {
  // Ids of the rows this page read, in cursor (id) order.
  readonly rowIds: readonly string[];
  // The page size asked for; a page this full may have more behind it.
  readonly batchSize: number;
  // How many of rowIds were processed to completion.
  readonly processed: number;
  // True when the deadline, not the end of the page, ended the batch.
  readonly stoppedEarly: boolean;
  // The cursor this page started from; null on the first page.
  readonly afterId: string | null;
  // Rows on this page whose gate ERRORED. They count as processed (the batch runner counts
  // a row once its handler returns), so the cursor moves past them while they are still
  // unjudged at passed_filters (reviewer finding, 2026-10-09).
  readonly errors: number;
}): { readonly done: true; readonly nextAfterId: null } | { readonly done: false; readonly nextAfterId: string | null } {
  // The end of the backlog was reached with every row read actually processed...
  const reachedEnd = !page.stoppedEarly && page.processed === page.rowIds.length && page.rowIds.length < page.batchSize;
  // ...and none of them errored: only then is the sweep complete.
  if (reachedEnd && page.errors === 0) return { done: true, nextAfterId: null };
  // The end was reached but some rows errored: NOT done. Restart from the beginning (null),
  // which re-judges survivors at no cost (no writes, no Gemini) and retries the errored rows.
  // Claiming done here would leave them unjudged and the operator believing it finished.
  if (reachedEnd) return { done: false, nextAfterId: null };
  // Otherwise resume after the last row actually finished; with none finished, resume where
  // this page began (null = from the start), so no row is ever skipped unjudged.
  const lastProcessed = page.processed > 0 ? page.rowIds[page.processed - 1] : undefined;
  // Not done: the caller must call again with this after_id.
  return { done: false, nextAfterId: lastProcessed ?? page.afterId };
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
  // OPTIONAL (2026-10-31): rows the gate must not judge at all, i.e. jobs the human picked by
  // pasting a link. Defaults to "none", so every existing caller and test is unchanged.
  skipGate: (row: R) => boolean = () => false,
): (row: R, call: C) => Promise<void> {
  return async (row, call) => {
    // The human already chose this job; the title/keyword gate exists to choose for them.
    if (skipGate(row)) return await score(row, call);
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
