// Tests for the full gate order with every seam faked. No network, no database.
import { test } from "node:test";
// Strict assertions.
import assert from "node:assert/strict";
import { handleScoutWeb, type Connection, type HandlerDeps, type RunPatch } from "./handler.ts";
import { buildApplicationRows, buildSearchPrompt, companyFor, discover, INSERT_STATUS, QuotaExhaustedError, runOutcome } from "./core.ts";

// A Greenhouse board payload containing exactly one posting, id 111.
const GH_BOARD = {
  jobs: [{ id: 111, title: "Senior Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/111", location: { name: "Bengaluru, India" } }],
};

// Everything a test may want to observe about side effects.
interface Spy {
  persisted: unknown[][];
  runs: RunPatch[];
  searches: number;
}

// Build deps with overridable pieces; defaults are the happy path.
function makeDeps(opts: {
  killSwitch?: { data: unknown[] | null; error: { message: string } | null };
  searchText?: string;
  fetchFails?: boolean;
  persistResult?: { inserted: number; errors: string[] };
  userId?: string;
  watchlist?: { ok: true; names: ReadonlyMap<string, { companyName: string; companySlug: string }> } | { ok: false; reason: string };
}): { deps: HandlerDeps; spy: Spy } {
  // Observations shared with the test.
  const spy: Spy = { persisted: [], runs: [], searches: 0 };
  // The faked connection.
  const conn: Connection = {
    userId: "app-user",
    db: {
      // Gate 1 seam: the token "good" belongs to opts.userId.
      auth: {
        getUser: (jwt: string) =>
          Promise.resolve(
            jwt === "good"
              ? { data: { user: { id: opts.userId ?? "app-user" } }, error: null }
              : { data: { user: null }, error: { message: "bad" } },
          ),
      },
      // Gate 2 seam: system_settings rows.
      from: () => ({ select: () => Promise.resolve(opts.killSwitch ?? { data: [{ system_enabled: true }], error: null }) }),
    },
    store: {
      // A minimal master profile so a prompt can be built.
      loadProfile: () => Promise.resolve({ ok: true as const, profile: { experience: [{ role: "Backend Engineer" }], skills: [{ name: "Node.js" }] } }),
      // Telemetry row id.
      openRun: () => Promise.resolve("run-1"),
      // Default: no board is tracked, so naming falls back to the board payload or the token.
      loadWatchlistNames: () => Promise.resolve(opts.watchlist ?? { ok: true as const, names: new Map() }),
      // Record how the run was closed.
      closeRun: (_id, patch) => {
        spy.runs.push(patch);
        return Promise.resolve();
      },
      // Record what would have been written.
      persist: (rows) => {
        spy.persisted.push([...rows]);
        return Promise.resolve(opts.persistResult ?? { inserted: rows.length, errors: [] });
      },
    },
    // Count paid model calls so the kill-switch test can assert zero.
    search: () => {
      spy.searches += 1;
      return Promise.resolve({ text: opts.searchText ?? "https://job-boards.greenhouse.io/acme/jobs/111", urls: [] });
    },
  };
  // Handler deps around the connection.
  return {
    spy,
    deps: {
      connect: () => Promise.resolve({ ok: true as const, ...conn }),
      fetchBoard: () =>
        Promise.resolve(opts.fetchFails ? { ok: false as const, reason: "robots_refuse: nope" } : { ok: true as const, payload: GH_BOARD }),
      // No test here exercises redirects, so any call is a refusal rather than a network hit.
      resolveRedirect: () => Promise.resolve({ ok: false as const, reason: "redirect_unused_in_test" }),
      now: () => new Date("2026-10-04T00:00:00Z"),
    },
  };
}

// A POST with the given bearer token and body.
function post(token: string | null, body: unknown = {}): Request {
  return new Request("https://x.test/scout-web", {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test("happy path: verified posting is inserted and reported", async () => {
  const { deps, spy } = makeDeps({});
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  // The title comes from the board, and the counts agree.
  assert.equal(body.status, "ok");
  assert.equal(body.proposed, 1);
  assert.equal(body.verified, 1);
  assert.equal(body.inserted, 1);
  assert.equal(body.jobs[0].title, "Senior Engineer");
  assert.equal(body.jobs[0].ats_provider, "greenhouse");
  assert.equal(spy.persisted.length, 1);
  // A clean run says succeeded with no error detail.
  assert.equal(spy.runs[0]?.status, "succeeded");
  assert.equal(spy.runs[0]?.error_detail, null);
});

test("kill switch off: 409 disabled, no search, no insert", async () => {
  const { deps, spy } = makeDeps({ killSwitch: { data: [{ system_enabled: false }], error: null } });
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).status, "disabled");
  // Neither the paid Gemini call nor any write happened.
  assert.equal(spy.searches, 0);
  assert.equal(spy.persisted.length, 0);
  assert.equal(spy.runs[0]?.status, "skipped_disabled");
});

test("kill switch unreadable: fails closed", async () => {
  const { deps, spy } = makeDeps({ killSwitch: { data: null, error: { message: "boom" } } });
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 503);
  assert.equal(spy.persisted.length, 0);
  assert.equal(spy.searches, 0);
});

test("missing, invalid and wrong-user tokens never reach search or insert", async () => {
  // No header and an unknown token are both 401.
  for (const token of [null, "bad"]) {
    const { deps, spy } = makeDeps({});
    const res = await handleScoutWeb(post(token), deps);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).status, "unauthorized");
    assert.equal(spy.searches, 0);
    assert.equal(spy.persisted.length, 0);
  }
  // A real session for someone else is 403.
  const { deps, spy } = makeDeps({ userId: "someone-else" });
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 403);
  assert.equal(spy.persisted.length, 0);
});

test("a proposed URL not in the live board is rejected and not inserted", async () => {
  // The model names posting 999; the board only has 111.
  const { deps, spy } = makeDeps({ searchText: "https://job-boards.greenhouse.io/acme/jobs/999" });
  const res = await handleScoutWeb(post("good"), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verified, 0);
  assert.equal(body.inserted, 0);
  assert.deepEqual(body.rejected, [{ url: "https://job-boards.greenhouse.io/acme/jobs/999", reason: "not_in_live_board" }]);
  // Nothing verified means nothing persisted.
  assert.equal(spy.persisted.length, 0);
  // A hallucination is a rejection, not an outage: the run still succeeded.
  assert.equal(spy.runs[0]?.status, "succeeded");
});

test("lookalike host from the model never reaches the board fetch", async () => {
  // Counts fetches so the test proves the gate sits BEFORE the network.
  let fetches = 0;
  const { deps } = makeDeps({ searchText: "https://boards.greenhouse.io.evil.com/acme/jobs/111" });
  const res = await handleScoutWeb(post("good"), {
    ...deps,
    fetchBoard: () => {
      fetches += 1;
      return Promise.resolve({ ok: false as const, reason: "x" });
    },
  });
  const body = await res.json();
  assert.equal(fetches, 0);
  assert.equal(body.rejected[0].reason, "host_not_allowed");
});

test("every board failing marks the run failed with a non-null detail", async () => {
  const { deps, spy } = makeDeps({ fetchFails: true });
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 200);
  assert.equal(spy.runs[0]?.status, "failed");
  assert.equal(spy.runs[0]?.error_count, 1);
  assert.match(spy.runs[0]?.error_detail ?? "", /robots_refuse/);
});

test("persist failure of every verified row is a 500 and a failed run", async () => {
  const { deps, spy } = makeDeps({ persistResult: { inserted: 0, errors: ["jobs_upsert: denied"] } });
  const res = await handleScoutWeb(post("good"), deps);
  assert.equal(res.status, 500);
  assert.equal(spy.runs[0]?.status, "failed");
  assert.match(spy.runs[0]?.error_detail ?? "", /jobs_upsert/);
});

test("bad bodies are refused with 400", async () => {
  // Each wrong type or out-of-range value must be refused, not coerced.
  for (const body of [{ limit: 0 }, { limit: 21 }, { limit: "5" }, { query: 5 }, { query: "x".repeat(201) }, [1]]) {
    const { deps } = makeDeps({});
    const res = await handleScoutWeb(post("good", body), deps);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("applications rows are always status discovered", () => {
  const rows = buildApplicationRows(["a", "b"]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    // Literal status and the constant agree, and no drop reason is invented.
    assert.equal(r.status, "discovered");
    assert.equal(r.status, INSERT_STATUS);
    assert.equal(r.drop_reason, null);
  }
});

test("discover caps candidates at the limit and dedupes", async () => {
  // 30 distinct Greenhouse URLs plus a duplicate of the first.
  const urls = Array.from({ length: 30 }, (_, i) => `https://boards.greenhouse.io/b${i}/jobs/${i + 1}`);
  const result = await discover(
    {
      search: () => Promise.resolve({ text: [...urls, urls[0]].join("\n"), urls: [] }),
      fetchBoard: () => Promise.resolve({ ok: false, reason: "x" }),
      // No redirect URLs in this input, so the resolver must never be reached.
      resolveRedirect: () => Promise.resolve({ ok: false, reason: "unused" }),
    },
    "p",
    20,
  );
  assert.equal(result.proposed, 20);
});

test("buildSearchPrompt: nothing to search for is null; hints are included", () => {
  assert.equal(buildSearchPrompt(null, null), null);
  // Malformed profile fields contribute nothing.
  assert.equal(buildSearchPrompt({ experience: "junk", skills: [5] }, "  "), null);
  assert.match(buildSearchPrompt({ experience: [{ role: "SRE" }] }, "fintech") ?? "", /SRE[\s\S]*fintech/);
});

test("runOutcome: all-failed is never succeeded", () => {
  const base = { searchFailed: false, boardsAttempted: 2, boardErrors: 0, errorSamples: [], persistErrors: [], verified: 0, inserted: 0 };
  assert.equal(runOutcome(base).status, "succeeded");
  assert.equal(runOutcome({ ...base, boardErrors: 2, errorSamples: ["a"] }).status, "failed");
  // Partial failure keeps the run succeeded but must carry a detail.
  const partial = runOutcome({ ...base, boardErrors: 1, errorSamples: ["a"] });
  assert.equal(partial.status, "succeeded");
  assert.equal(partial.errorDetail, "a");
});

// Swap the search seam on an existing deps object, since search lives on the Connection.
function withSearch(deps: HandlerDeps, search: Connection["search"]): HandlerDeps {
  return {
    ...deps,
    // Same connection, different search, so every other default stays the happy path.
    connect: async () => {
      const c = await deps.connect();
      return c.ok ? { ...c, search } : c;
    },
  };
}

test("quota exhaustion is a 429 and a skipped_quota run with zero errors, never 'failed'", async () => {
  const { deps, spy } = makeDeps({});
  // The seam's signal for "every key cooling or daily budget spent".
  const res = await handleScoutWeb(post("good"), withSearch(deps, () => Promise.reject(new QuotaExhaustedError())));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).status, "quota");
  assert.equal(spy.runs[0]?.status, "skipped_quota");
  // Nothing went wrong, so the health page must not count it.
  assert.equal(spy.runs[0]?.error_count, 0);
});

test("any other search failure is still a 502 and a failed run", async () => {
  const { deps, spy } = makeDeps({});
  // A plain Error is a real failure, and must not be mistaken for quota.
  const res = await handleScoutWeb(post("good"), withSearch(deps, () => Promise.reject(new Error("gemini_http_error"))));
  assert.equal(res.status, 502);
  assert.equal(spy.runs[0]?.status, "failed");
  assert.equal(spy.runs[0]?.error_count, 1);
});

test("a tracked board takes its watchlist name and slug, so fingerprints match scout-ats", async () => {
  const names = new Map([["greenhouse:acme", { companyName: "Acme Inc", companySlug: "acme-inc" }]]);
  const { deps, spy } = makeDeps({ watchlist: { ok: true, names } });
  const res = await handleScoutWeb(post("good"), deps);
  const body = await res.json();
  assert.equal(body.jobs[0].company_name, "Acme Inc");
  // The stored row carries the same name and the watchlist's slug, not the token's.
  const row = spy.persisted[0]?.[0] as { company_name: string; company_slug: string };
  assert.equal(row.company_name, "Acme Inc");
  assert.equal(row.company_slug, "acme-inc");
});

test("an untracked board uses the board payload's company_name, then the token", async () => {
  // The same posting, but the board's JSON names its employer.
  const named = { jobs: [{ ...GH_BOARD.jobs[0], company_name: "  Acme Corporation  " }] };
  const { deps } = makeDeps({});
  const res = await handleScoutWeb(post("good"), { ...deps, fetchBoard: () => Promise.resolve({ ok: true as const, payload: named }) });
  // Trimmed board name wins over the token.
  assert.equal((await res.json()).jobs[0].company_name, "Acme Corporation");
});

test("a failed watchlist read falls back to the token and is reported, not swallowed", async () => {
  const { deps, spy } = makeDeps({ watchlist: { ok: false, reason: "rls denied" } });
  const res = await handleScoutWeb(post("good"), deps);
  // Still a success: naming degraded, the posting was saved.
  assert.equal(res.status, 200);
  assert.equal((await res.json()).jobs[0].company_name, "acme");
  assert.match(spy.runs[0]?.error_detail ?? "", /watchlist_lookup: rls denied/);
});

test("companyFor ignores blank, non-string and oversized board names", () => {
  for (const bad of ["   ", 5, null, "x".repeat(201)]) {
    assert.deepEqual(companyFor(null, { company_name: bad }, "Acme_Co"), { companyName: "Acme_Co", companySlug: "acme-co" });
  }
});
