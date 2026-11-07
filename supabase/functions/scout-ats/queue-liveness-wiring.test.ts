// Wiring tests for queue liveness in scout-ats (2026-11-07). The decisions live in
// _shared/scout/queue-liveness.ts and are tested there; these pin the two properties the pure tests
// cannot see: the confirmation runs only on a poll the liveness planner TRUSTED, and only through the
// robots-gated board transport. Same source-reading style as workday-wiring.test.ts, because the
// handler is one Deno.serve closure with a live database behind it.
import { describe, it } from "node:test";
// Strict, so a missing anchor never compares equal.
import assert from "node:assert/strict";
// The handler's source, read as text.
import { readFileSync } from "node:fs";

// The file under test.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

// The offset of a literal anchor, or a named failure when it is gone.
function at(needle: string): number {
  // indexOf, so the needle is literal text, not a regex.
  const index = source.indexOf(needle);
  // A missing anchor is a failure of its own, named.
  assert.ok(index >= 0, `index.ts no longer contains: ${needle}`);
  // Found.
  return index;
}

describe("scout-ats: queue liveness wiring", () => {
  it("confirms only after the planner ran, and only when it did not refuse the poll", () => {
    // The planner's verdict on this poll.
    const plan = at("const plan = planDisappearances(");
    // The trust guard: a refused plan means the listing is not evidence of anything.
    const guard = at('if (plan.kind !== "refuse") {');
    // The candidates, built from the planner's own marks so nothing is confirmed twice.
    const candidates = at("queueCandidates(snapshot, polledFingerprints, plan.ids)");
    // Order: plan, guard, candidates.
    assert.ok(plan < guard && guard < candidates, `order wrong: plan@${plan}, guard@${guard}, candidates@${candidates}`);
  });

  it("asks the posting endpoint through the robots-gated board transport, within the run's cap", () => {
    // fetchBoard applies the 'scouting' robots policy; a bare fetch here would skip robots.txt.
    at('checkPosting((u) => fetchBoard(u), board.ats_provider, url)');
    // The shared per-run allowance is checked before a request is spent.
    const capCheck = at("if (queueChecksLeft <= 0) break;");
    // The request itself.
    const request = at("checkPosting((u) => fetchBoard(u)");
    // Cap first.
    assert.ok(capCheck < request, `cap checked after the request: cap@${capCheck}, request@${request}`);
  });

  it("selects what the posting endpoint and the queue filter need", () => {
    // ats_job_id + apply_url build the endpoint; applications(id, status) picks the queue rows.
    at('last_seen_at, ats_job_id, apply_url, applications(id, status)")');
  });
});
