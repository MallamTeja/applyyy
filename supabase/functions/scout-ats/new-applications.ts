// The run's tally of applications the scan actually INSERTED, by status and drop reason (P1-5, 2026-11-05).
//
// WHY: the response's applications_created counted every inserted row, and the Scan popup called them
// all "new applications". Teja's 39 were all dropped (26 tech_gate, 12 unclassified, 1 work_auth).
// screened_passed/screened_dropped cannot answer it either: they count every posting the screener
// judged, re-sighted ones included, while the upsert inserts only new rows (ignoreDuplicates). So
// the tally reads the rows the upsert returned. Pure, so it is testable without Deno.serve.

// The run's running counts. A Map for the reasons, so a new drop code needs no code change here.
export interface NewApplicationTally {
  // Rows born passed_filters: the "Ready to tailor" lane.
  passed: number;
  // Rows born dropped_filter.
  dropped: number;
  // Rows born discovered: the screener could not run (the unscreened fallback).
  unscreened: number;
  // drop_reason -> count, over the dropped rows.
  readonly dropReasons: Map<string, number>;
}

// The reason a dropped row with no stored drop_reason is reported under: named, never guessed.
const NO_REASON = "no_reason_stored";

// A fresh tally for one run.
export function newApplicationTally(): NewApplicationTally {
  // All zero.
  return { passed: 0, dropped: 0, unscreened: 0, dropReasons: new Map() };
}

// Add one board's inserted rows, as `.select("id, status, drop_reason")` on the upsert returns them.
export function addInsertedApplications(tally: NewApplicationTally, rows: readonly { readonly status: unknown; readonly drop_reason: unknown }[]): void {
  // Each row counted once, by the status it was born at.
  for (const row of rows) {
    // The scan's success lane.
    if (row.status === "passed_filters") tally.passed += 1;
    // Unscreened fallback.
    else if (row.status === "discovered") tally.unscreened += 1;
    // A drop, with its reason.
    else if (row.status === "dropped_filter") {
      // Counted.
      tally.dropped += 1;
      // The stored code, or the explicit "none stored".
      const reason = typeof row.drop_reason === "string" && row.drop_reason !== "" ? row.drop_reason : NO_REASON;
      // Grouped.
      tally.dropReasons.set(reason, (tally.dropReasons.get(reason) ?? 0) + 1);
    }
    // guard_status_insert admits only these three; anything else means that guard changed, and a
    // silent bucket would make the popup's numbers wrong. Loud instead (CLAUDE.md §6).
    else throw new Error(`scout-ats: an inserted application has status ${String(row.status)}, which the insert guard never admits`);
  }
}

// The response field: counts plus every reason, most first, then by name for a stable order.
export function newApplicationsReport(tally: NewApplicationTally): { passed: number; dropped: number; unscreened: number; drop_reasons: { reason: string; count: number }[] } {
  // Sorted copy of the reasons.
  const reasons = [...tally.dropReasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  // The shape the web validates (discoveryService.ts parseScoutAtsResponse).
  return { passed: tally.passed, dropped: tally.dropped, unscreened: tally.unscreened, drop_reasons: reasons };
}
