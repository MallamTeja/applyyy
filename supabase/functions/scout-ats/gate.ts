// The scout's run gate, in a module of its own: index.ts executes Deno.serve on import,
// so `node --test` can only reach logic that lives outside it (same pattern as
// email-tracker-intake/decide.ts).

/**
 * Whether this run is halted by the kill switch (`system_settings.system_enabled`).
 * `force` is accepted and DELIBERATELY ignored for the halt itself: since 2026-10-23 the
 * kill switch is absolute — a switch a query param can bypass is not a kill switch
 * (CLAUDE.md §6: a guard that can pass vacuously is not a guard). The parameter stays in
 * the signature so this contract is pinned by a named test rather than by a comment:
 * reintroducing `&& !force` turns that test red.
 */
export function haltedByKillSwitch(systemEnabled: boolean, _force: boolean): boolean {
  // Disabled halts every caller, forced or not.
  return !systemEnabled;
}

// What the run's screener context load said. Only `ok` and the failure reason matter here,
// so loadScreenContext's full result is accepted as is.
export type ScreenContextOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// The facts the run close is decided from, gathered by index.ts after the board loop.
export interface ScoutRunCloseInput {
  // Boards actually polled; skipped ones (no adapter) are neither success nor failure.
  readonly attemptedBoards: number;
  // "provider/board: reason" for every board whose poll failed.
  readonly failedBoardDetails: readonly string[];
  // "provider/board: reason" for every refused disappearance marking (not errors).
  readonly livenessRefusals: readonly string[];
  // Whether the screener could run at all.
  readonly screenContext: ScreenContextOutcome;
}

// How the run row closes and how the caller is answered.
export interface ScoutRunClose {
  // `failed` only when every attempted board failed (the honest close of 2026-10-04).
  readonly status: "succeeded" | "failed";
  // Board failures, plus one when the screener did not run.
  readonly errorCount: number;
  // Labelled segments joined by "; ", or null for a clean run (withRuleWarnings appends after).
  readonly errorDetail: string | null;
  // Null answers 200 as before; otherwise the non-2xx the caller must see.
  readonly httpError: null | { readonly status: 500; readonly error: "screener_not_run"; readonly detail: string };
}

/**
 * W12 (wiring audit 2026-11-01). When the screener's context cannot load, the scout still
 * inserts its rows (at 'discovered', a true statement: they are unscreened), but it used to
 * close the run `succeeded` with 0 errors and answer 200, so the Health page stayed green
 * while every new posting sat where nothing scheduled reads it. Now that fallback is an
 * error on the run row and a non-2xx to the caller. The rows are kept either way.
 */
export function planScoutRunClose(input: ScoutRunCloseInput): ScoutRunClose {
  // The screener's failure reason, or null when it ran.
  const notRun = input.screenContext.ok ? null : input.screenContext.reason;
  // Every attempted board failed: the run did not do its polling job.
  const allBoardsFailed = input.attemptedBoards > 0 && input.failedBoardDetails.length === input.attemptedBoards;
  // Segments in priority order: the screener first, so the detail cap never cuts it; then
  // the first five board failures; then liveness refusals in their own labelled segment, so
  // a refusal is never mistaken for one of the error_count failures.
  const segments = [
    // W12's segment, present only when screening was skipped.
    ...(notRun === null ? [] : [`screener_not_run: ${notRun}`]),
    // Bounded so a run over many dead boards keeps the column short.
    ...input.failedBoardDetails.slice(0, 5),
    // Unchanged from before W12.
    ...(input.livenessRefusals.length > 0 ? [`liveness_refused: ${input.livenessRefusals.slice(0, 5).join(", ")}`] : []),
  ];
  return {
    // Unchanged rule: a screener failure alone does not fail a run that polled its boards.
    status: allBoardsFailed ? "failed" : "succeeded",
    // The unscreened insert is one error on top of the board failures.
    errorCount: input.failedBoardDetails.length + (notRun === null ? 0 : 1),
    // Null, not "", for a clean run, so the column stays null as before.
    errorDetail: segments.length > 0 ? segments.join("; ") : null,
    // 500 rather than a flagged 200: the browser's discoveryService reports any non-2xx with
    // its body, while a 200 with success:false would read as an unrecognised response.
    httpError: notRun === null ? null : { status: 500, error: "screener_not_run", detail: notRun },
  };
}
