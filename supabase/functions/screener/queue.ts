// The screener's queue rules, pure so node --test can drive them (index.ts calls Deno.serve on import).
//
// HELD ROWS (2026-11-12, Teja via the orchestrator, plan B). screen-batch.ts holds a job with no description and no
// title verdict against it: the row stays at `deduped` until a scout poll stores the job's text. Two things follow:
// 1. The queue must not FETCH such a row. The select is oldest-first with a page limit and no cursor, so a held row it
//    fetched would sort first on every run: past one page of held rows, newer rows are never reached, and
//    prescreen-drain.yml aborts red after 3 stalled pages (STALL_CAP). So only rows whose job has text are fetched; a
//    held row comes back by itself the run after its text arrives (the select joins jobs.description_raw live).
// 2. A held verdict is never written: `deduped -> discovered` is no edge, and the row is already where it waits.
import type { ScreenedApplicationInsert } from "../_shared/screen/screen-batch.ts";
// The verdict shape the one write path accepts.
import type { ScreenVerdict } from "../_shared/screen/persist-verdict.ts";

// The columns the screener reads. `jobs!inner` is what makes the filter below remove the APPLICATION row: with a plain
// embed, PostgREST would filter the embedded job to null and still return the application (then failed as
// missing_job_record by index.ts).
export const DEDUPED_QUEUE_SELECT =
  "id, job_id, user_id, status, jobs!inner ( id, fingerprint, title, company_name, company_slug, location_raw, locations, employment_type, min_experience_years, requires_advanced_degree, posted_at, posted_at_source, description_raw )";

// The text filter itself (not null, not empty, on jobs.description_raw) is written INLINE in index.ts's query: a
// helper generic over supabase-js's builder made deno check fail with TS2589 ("type instantiation is excessively
// deep"), measured 2026-11-12. queue.test.ts reads index.ts and pins both calls instead.

/* What the screener does with one planned row. A closed union: a held row has no verdict to carry. */
export type QueueAction =
  // Leave the row at `deduped`; nothing is written.
  | { readonly kind: "hold" }
  // Write this verdict through persistScreenVerdict.
  | { readonly kind: "persist"; readonly verdict: ScreenVerdict };

/* Map a planned row to the screener's action. Exhaustive over ScreenedInsertStatus: a fourth status is a compile error
   here, never a silent fall into "dropped" (the old ternary in index.ts mapped everything not passed to a drop). */
export function queueActionFor(insert: ScreenedApplicationInsert): QueueAction {
  // One case per status.
  switch (insert.status) {
    // Held: nothing to write.
    case "discovered":
      return { kind: "hold" };
    // A pass never carries a reason.
    case "passed_filters":
      return { kind: "persist", verdict: { status: "passed_filters", reason: null } };
    // A drop carries the rule that made it.
    case "dropped_filter":
      return { kind: "persist", verdict: { status: "dropped_filter", reason: insert.drop_reason } };
    // Unreachable while the union is closed; a new member fails to compile here.
    default: {
      // The compiler proves this is never.
      const unhandled: never = insert.status;
      // Thrown, never guessed, if it is ever reached at runtime.
      throw new Error(`screener: unhandled insert status ${String(unhandled)}`);
    }
  }
}
