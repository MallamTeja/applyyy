// Tests for the one-hop grounding redirect resolver, alone and wired through discover().
// Every fetch is a fake: these tests must pass with the network unplugged.
import { test } from "node:test";
// Strict assertions so a missing key never equals an undefined one.
import assert from "node:assert/strict";
// The unit under test and the seam type the fakes must satisfy.
import { isGroundingRedirect, resolveGroundingRedirect, type RedirectFetch } from "./redirects.ts";
// The pipeline, so we can prove a resolved URL still has to pass the strict shape check.
import { discover } from "./core.ts";

// A realistic redirect URI, shaped like what groundingMetadata returns.
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
// The real posting the redirect points at, matching the board fixture below.
const GH_POSTING = "https://job-boards.greenhouse.io/acme/jobs/111";
// A Greenhouse board payload holding exactly that posting, so verification can succeed.
const GH_BOARD = {
  // One job, id 111, the shape the greenhouse adapter parses.
  jobs: [{ id: 111, title: "Senior Engineer", absolute_url: GH_POSTING, location: { name: "Bengaluru, India" } }],
};

// A fake fetch that answers one fixed response and records every call it receives.
function fakeFetch(respond: () => Response): { fn: RedirectFetch; calls: { url: string; redirect: string }[] } {
  // Visible to the test, so "was the network touched, and how" can be asserted.
  const calls: { url: string; redirect: string }[] = [];
  // Same signature as the production seam.
  const fn: RedirectFetch = (url, init) => {
    // Record the URL and the redirect mode, which must always be 'manual'.
    calls.push({ url, redirect: init.redirect });
    // Fresh Response per call, since a body can only be consumed once.
    return Promise.resolve(respond());
  };
  // Both halves go back to the test.
  return { fn, calls };
}

// A 302 pointing at `location`, the shape Google's redirect endpoint answers with.
function redirectTo(location: string): Response {
  // Null body: the resolver must never need one.
  return new Response(null, { status: 302, headers: { location } });
}

test("redirect to a greenhouse posting resolves, using exactly one manual hop", async () => {
  // Google answers with the real posting URL.
  const { fn, calls } = fakeFetch(() => redirectTo(GH_POSTING));
  // Resolve it.
  const result = await resolveGroundingRedirect(REDIRECT, fn);
  // The Location is handed back unchanged.
  assert.deepEqual(result, { ok: true, url: GH_POSTING });
  // Exactly one request, to the redirect URL only, never to the posting itself.
  assert.deepEqual(calls, [{ url: REDIRECT, redirect: "manual" }]);
});

test("discover: a redirect to a real posting is verified on the live board", async () => {
  // The model's prose is empty; the only candidate is the grounding redirect.
  const result = await discover(
    {
      // Grounding metadata supplies the redirect URL, exactly as Gemini does.
      search: () => Promise.resolve({ text: "", urls: [REDIRECT] }),
      // The board really contains posting 111.
      fetchBoard: () => Promise.resolve({ ok: true, payload: GH_BOARD }),
      // The resolver over a fake fetch, wired the same way index.ts wires it.
      resolveRedirect: (u) => resolveGroundingRedirect(u, fakeFetch(() => redirectTo(GH_POSTING)).fn),
    },
    "p",
    20,
  );
  // One posting got through end to end. This is the recall the fix exists to recover.
  assert.equal(result.verified.length, 1);
  // Its id came from the resolved URL and was confirmed by the board.
  assert.equal(result.verified[0]?.posting.atsJobId, "111");
  // Nothing was refused.
  assert.deepEqual(result.rejected, []);
});

test("discover: a redirect to an evil host is rejected by the shape check and never fetched", async () => {
  // Counts board fetches, to prove the shape check still sits in front of the network.
  let boardFetches = 0;
  // The redirect resolves, but to a lookalike host.
  const evil = "https://job-boards.greenhouse.io.evil.com/acme/jobs/111";
  // Run the full pipeline.
  const result = await discover(
    {
      // Grounding returns only the redirect.
      search: () => Promise.resolve({ text: "", urls: [REDIRECT] }),
      // Must never be reached.
      fetchBoard: () => {
        // Any increment fails the assertion below.
        boardFetches += 1;
        // Shape required by the type. Unreachable in a passing run.
        return Promise.resolve({ ok: false, reason: "x" });
      },
      // Google hands back the evil target.
      resolveRedirect: (u) => resolveGroundingRedirect(u, fakeFetch(() => redirectTo(evil)).fn),
    },
    "p",
    20,
  );
  // The target is refused by the same rule that refuses it when typed directly.
  assert.deepEqual(result.rejected, [{ url: evil, reason: "host_not_allowed" }]);
  // And it never cost a board request.
  assert.equal(boardFetches, 0);
});

test("a non-https Location is refused", async () => {
  // Downgraded scheme on an otherwise genuine posting URL.
  const { fn } = fakeFetch(() => redirectTo("http://job-boards.greenhouse.io/acme/jobs/111"));
  // The resolver must not hand on a plaintext target.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, fn), { ok: false, reason: "redirect_not_https" });
});

test("a javascript: Location is refused", async () => {
  // A scheme that would be dangerous anywhere it was rendered as a link.
  const { fn } = fakeFetch(() => redirectTo("javascript:alert(1)"));
  // Same refusal as http: anything that is not https.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, fn), { ok: false, reason: "redirect_not_https" });
});

test("a 3xx with no Location is a rejection with a reason", async () => {
  // A redirect status with no target to read.
  const { fn } = fakeFetch(() => new Response(null, { status: 302 }));
  // Reported, not thrown and not silently dropped.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, fn), { ok: false, reason: "redirect_no_location" });
});

test("a 200 is not a redirect, even if it carries a Location", async () => {
  // Google serving a page (interstitial, consent) instead of redirecting.
  const { fn } = fakeFetch(() => new Response("<html></html>", { status: 200, headers: { location: GH_POSTING } }));
  // Only a 3xx counts, so this header is not trusted.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, fn), { ok: false, reason: "redirect_status_200" });
});

test("a timeout is a rejection with a reason, not a hang or a throw", async () => {
  // A fetch that never answers on its own and fails only when the signal aborts, like a stuck socket.
  const hang: RedirectFetch = (_url, init) =>
    // Settles only through the abort path.
    new Promise((_resolve, reject) => {
      // Mirrors real fetch, which rejects once its signal fires.
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  // A 20ms budget keeps the test fast. The production default is 5s.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, hang, 20), { ok: false, reason: "redirect_timeout" });
});

test("a network failure is a rejection with a reason", async () => {
  // DNS failure, connection reset, and so on: anything that throws before a response.
  const boom: RedirectFetch = () => Promise.reject(new TypeError("network down"));
  // Distinguished from a timeout so the health page can tell slow from unreachable.
  assert.deepEqual(await resolveGroundingRedirect(REDIRECT, boom), { ok: false, reason: "redirect_fetch_failed" });
});

test("lookalike redirect hosts are never fetched", async () => {
  // Every one of these must be refused without a single request leaving the function.
  const { fn, calls } = fakeFetch(() => redirectTo(GH_POSTING));
  // Suffix, prefix, userinfo, port, plaintext and subdomain variants of the Google host.
  for (const url of [
    // Real host used as a label in an attacker domain.
    "https://vertexaisearch.cloud.google.com.evil.com/grounding-api-redirect/x",
    // Attacker label in front of the real host.
    "https://evil.vertexaisearch.cloud.google.com/grounding-api-redirect/x",
    // Userinfo trick: the real host appears before an @.
    "https://vertexaisearch.cloud.google.com@evil.com/grounding-api-redirect/x",
    // Non-default port.
    "https://vertexaisearch.cloud.google.com:8443/grounding-api-redirect/x",
    // Plaintext.
    "http://vertexaisearch.cloud.google.com/grounding-api-redirect/x",
  ]) {
    // The classifier says no, so discover() never routes it to the resolver.
    assert.equal(isGroundingRedirect(url), false, url);
    // And the resolver refuses on its own, even if a caller skipped the classifier.
    assert.deepEqual(await resolveGroundingRedirect(url, fn), { ok: false, reason: "redirect_host_not_allowed" }, url);
  }
  // Not one request was made.
  assert.equal(calls.length, 0);
});
