// P1-5 (2026-11-05): the Scan popup's "N new applications" counted EVERY inserted row, including
// rows born dropped_filter. Teja's 39 "new" were all dropped (26 tech_gate, 12 unclassified,
// 1 work_auth). scout-ats now tallies the rows its applications upsert actually inserted, by status
// and drop reason, so the popup can say "X passed, Y dropped" and why. These tests pin the tally.
import { test } from "node:test";
// Strict deep equality.
import assert from "node:assert/strict";
// The helper under test.
import { addInsertedApplications, newApplicationsReport, newApplicationTally } from "./new-applications.ts";

test("Teja's scan: 39 inserted, all dropped, reported by reason, most first", () => {
  // A fresh run tally.
  const tally = newApplicationTally();
  // The rows the upsert returned, as .select("id, status, drop_reason") gives them.
  addInsertedApplications(tally, [
    ...Array.from({ length: 26 }, () => ({ status: "dropped_filter", drop_reason: "tech_gate" })),
    ...Array.from({ length: 12 }, () => ({ status: "dropped_filter", drop_reason: "unclassified" })),
    { status: "dropped_filter", drop_reason: "work_auth" },
  ]);
  // Nothing passed; every reason with its count, most first.
  assert.deepEqual(newApplicationsReport(tally), {
    passed: 0,
    dropped: 39,
    unscreened: 0,
    drop_reasons: [{ reason: "tech_gate", count: 26 }, { reason: "unclassified", count: 12 }, { reason: "work_auth", count: 1 }],
  });
});

test("passed and unscreened rows are counted apart, across several boards", () => {
  // One tally for the run.
  const tally = newApplicationTally();
  // Board one: two pass, one drops.
  addInsertedApplications(tally, [{ status: "passed_filters", drop_reason: null }, { status: "passed_filters", drop_reason: null }, { status: "dropped_filter", drop_reason: "work_auth" }]);
  // Board two: the screener was unavailable.
  addInsertedApplications(tally, [{ status: "discovered", drop_reason: null }]);
  // The run's totals.
  assert.deepEqual(newApplicationsReport(tally), { passed: 2, dropped: 1, unscreened: 1, drop_reasons: [{ reason: "work_auth", count: 1 }] });
});

test("a dropped row with no stored reason is reported as such, not as a made-up one", () => {
  // One tally.
  const tally = newApplicationTally();
  // A drop without a reason.
  addInsertedApplications(tally, [{ status: "dropped_filter", drop_reason: null }]);
  // Named for what it is.
  assert.deepEqual(newApplicationsReport(tally).drop_reasons, [{ reason: "no_reason_stored", count: 1 }]);
});

test("a status the insert guard never admits is refused loudly, never bucketed", () => {
  // One tally.
  const tally = newApplicationTally();
  // guard_status_insert admits only discovered | passed_filters | dropped_filter.
  assert.throws(() => addInsertedApplications(tally, [{ status: "approved", drop_reason: null }]), /approved/);
});
