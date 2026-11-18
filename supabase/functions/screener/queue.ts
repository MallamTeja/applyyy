// The screener's queue rules, pure so node --test can drive them (index.ts calls Deno.serve on import).
//
// NO HOLD SINCE 2026-11-18 (Teja 21:46 IST: "no jd jobs also need to be in ready to tailor"). The 2026-11-12 hold kept a
// no-description row at `deduped` and filtered it out of the query; screen-batch.ts now screens such a row and
// passes it to passed_filters, so the query fetches every deduped row again (index.ts) and the select is a plain embed.
// The "hold" action below stays only because ScreenedInsertStatus still carries 'discovered' for the scouts' unscreened
// fallback (context load failed); the planner itself never emits it, and `deduped -> discovered` is no edge anyway.
import type { ScreenedApplicationInsert } from "../_shared/screen/screen-batch.ts";
// The verdict shape the one write path accepts.
import type { ScreenVerdict } from "../_shared/screen/persist-verdict.ts";

// The columns the screener reads. A PLAIN embed (2026-11-18, the !inner of the hold is gone): with no job filter to apply,
// an inner join would only hide an application whose job row is missing, where index.ts fails it as missing_job_record.
export const DEDUPED_QUEUE_SELECT =
  "id, job_id, user_id, status, jobs ( id, fingerprint, title, company_name, company_slug, location_raw, locations, employment_type, min_experience_years, requires_advanced_degree, posted_at, posted_at_source, description_raw )";

/* What the screener does with one planned row. A closed union: a 'discovered' plan has no verdict to carry. */
export type QueueAction =
  // Leave the row at `deduped`; nothing is written (a 'discovered' plan, never produced by the planner today).
  | { readonly kind: "hold" }
  // Write this verdict through persistScreenVerdict.
  | { readonly kind: "persist"; readonly verdict: ScreenVerdict };

/* Map a planned row to the screener's action. Exhaustive over ScreenedInsertStatus: a fourth status is a compile error
   here, never a silent fall into "dropped" (the old ternary in index.ts mapped everything not passed to a drop). */
export function queueActionFor(insert: ScreenedApplicationInsert): QueueAction {
  // One case per status.
  switch (insert.status) {
    // Not a screener verdict: nothing to write.
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
