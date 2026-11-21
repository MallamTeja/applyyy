// The screener's queue rules, pure so node --test can drive them (index.ts calls Deno.serve on import).
//
// NO HOLD SINCE 2026-11-18 (Teja 21:46 IST: "no jd jobs also need to be in ready to tailor"). The 2026-11-12 hold kept a
// no-description row at `deduped` and filtered it out of the query; screen-batch.ts now screens such a row and
// passes it to passed_filters, so the query fetches every deduped row again (index.ts) and the select is a plain embed.
// NO HOLD BRANCH SINCE ROUND 7 (2026-11-21): the planner's own type (PlannedInsertStatus) cannot hold 'discovered', so
// every planned row is a verdict. 'discovered' lives on only in the scouts' unscreened-fallback insert type, which never
// reaches the screener (and `deduped -> discovered` is no edge anyway).
import type { PlannedApplicationInsert } from "../_shared/screen/screen-batch.ts";
// The verdict shape the one write path accepts.
import type { ScreenVerdict } from "../_shared/screen/persist-verdict.ts";

// The columns the screener reads. A PLAIN embed (2026-11-18, the !inner of the hold is gone): with no job filter to apply,
// an inner join would only hide an application whose job row is missing, where index.ts fails it as missing_job_record.
export const DEDUPED_QUEUE_SELECT =
  "id, job_id, user_id, status, jobs ( id, fingerprint, title, company_name, company_slug, location_raw, locations, employment_type, min_experience_years, requires_advanced_degree, posted_at, posted_at_source, description_raw )";

/* The verdict for one planned row (renamed from queueActionFor in round 7: with no hold there is no "action" to choose,
   only the verdict to write). Exhaustive over PlannedInsertStatus: a third status is a compile error here, never a silent
   fall into "dropped" (the old ternary in index.ts mapped everything not passed to a drop). */
export function screenVerdictFor(insert: PlannedApplicationInsert): ScreenVerdict {
  // One case per status.
  switch (insert.status) {
    // A pass never carries a reason.
    case "passed_filters":
      return { status: "passed_filters", reason: null };
    // A drop carries the rule that made it.
    case "dropped_filter":
      return { status: "dropped_filter", reason: insert.drop_reason };
    // Unreachable while the union is closed; a new member fails to compile here.
    default: {
      // The compiler proves this is never.
      const unhandled: never = insert.status;
      // Thrown, never guessed, if it is ever reached at runtime.
      throw new Error(`screener: unhandled insert status ${String(unhandled)}`);
    }
  }
}
