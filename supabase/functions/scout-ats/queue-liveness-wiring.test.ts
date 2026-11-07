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
function at(needle: string, from = 0): number {
  // indexOf, so the needle is literal text, not a regex; `from` finds the occurrence after an anchor.
  const index = source.indexOf(needle, from);
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
    at('checkPosting((u) => fetchBoard(u), board.ats_provider, url, job.ats_job_id)');
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

// Feed liveness (2026-11-07): rows with no ATS, probed on their own page. The decisions are tested in
// _shared/scout/feed-liveness.test.ts; these pin the transport, the select and the run-row reporting.
describe("scout-ats: feed liveness wiring", () => {
  it("probes through the robots-gated PAGE transport, never a bare fetch or the JSON board GET", () => {
    // fetchPage applies the 'scouting' robots policy and asks for HTML (a JSON Accept can 404).
    at("probeFeedRows(feedRows as FeedLivenessRow[], (u) => deadline.remainingMs() < FEED_PROBE_MIN_REMAINING_MS ? Promise.resolve(null) : fetchPage(u), FEED_LIVENESS_CAP)");
  });

  it("selects live no-ATS rows with an in-flight application, owner-scoped", () => {
    // The inner join is what drops jobs whose applications are all done.
    const select = at('.select("id, apply_url, disappeared_at, applications!inner(id, status)")');
    // Only the providers the board loop cannot see.
    const providers = at('.in("ats_provider", [...FEED_LIVENESS_PROVIDERS])');
    // Already-retired rows are never re-probed.
    const live = at('.is("disappeared_at", null)', select);
    // The in-flight statuses only.
    const statuses = at('.in("applications.status", [...FEED_LIVENESS_STATUSES])');
    // One chain, in this order.
    assert.ok(select < providers && providers < live && live < statuses, `select chain out of order`);
  });

  it("runs after the board loop and reports its refusals on the run row", () => {
    // The probe call.
    const probe = at("const probe = await probeFeedRows(");
    // The run close reads livenessRefusals, which now carries the feed refusals.
    const concat = at(".concat(feedRefusals);");
    // The close itself.
    const close = at("const close = planScoutRunClose({");
    // Probe, then the refusals list, then the close.
    assert.ok(probe < concat && concat < close, `order wrong: probe@${probe}, concat@${concat}, close@${close}`);
  });
});
