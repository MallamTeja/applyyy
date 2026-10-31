// job-link-intake fetch-page: the SSRF guard between a stranger's pasted link and our server's fetch.
// Protects: the private-address table, the private-hostname check, and the hand-followed redirect
// loop that must re-check every hop BEFORE requesting it (a refused hop is never fetched).
// Run with: node --test "supabase/functions/job-link-intake/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPublicPage, isBlockedHost, isPublicAddress, MAX_PAGE_BYTES, MAX_REDIRECTS, type PageFetchDeps } from "./fetch-page.ts";

// Addresses that are NOT the public internet: loopback, RFC1918 edges, link-local metadata,
// CGNAT, unspecified, multicast, benchmarking, every IPv6 private form, NAT64, and junk.
const PRIVATE_ADDRESSES = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "224.0.0.1",
  "198.18.0.1",
  "::1",
  "::",
  "::ffff:127.0.0.1",
  "fd00::1",
  "fe80::1",
  "ff02::1",
  "64:ff9b::a00:1",
  "garbage",
];

// Public addresses, including the first one just past each private range's edge.
const PUBLIC_ADDRESSES = ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"];

// Fake seams honouring the real contract: fetchHop resolves a Response or null, resolve an array.
// Every call is recorded so a test can prove a refused hop was never requested.
function fakeDeps(opts: { hop: (url: string) => Response | null; dns?: Record<string, string[]> }) {
  // Every URL fetchHop was asked for, in order.
  const fetched: string[] = [];
  // Every hostname resolve was asked for, in order.
  const resolved: string[] = [];
  // The two effects fetchPublicPage is allowed to perform.
  const deps: PageFetchDeps = {
    fetchHop: (url) => {
      // Recorded before answering, so even a refused-after-fetch path would show up.
      fetched.push(url);
      // A fresh Response per call: a body can only be read once.
      return Promise.resolve(opts.hop(url));
    },
    resolve: (host) => {
      // Recorded so a test can see which hops reached DNS.
      resolved.push(host);
      // Unlisted hosts resolve to a public address; a test overrides only the host it targets.
      return Promise.resolve(opts.dns?.[host] ?? ["8.8.8.8"]);
    },
  };
  // The seams plus the two call logs.
  return { deps, fetched, resolved };
}

// A redirect Response; location omitted means a 3xx with no target.
function redirect(location?: string): Response {
  // A 302 carries no body; headers only when a target is given.
  return new Response(null, { status: 302, headers: location === undefined ? {} : { location } });
}

// The page every happy path returns.
const PAGE = "<html><body>Senior Engineer at Acme</body></html>";

// Each private address must be refused, or a resolved name could reach it.
test("isPublicAddress: every private, reserved or unparseable address is not public", () => {
  // One assertion per row; the message names the row that broke.
  for (const ip of PRIVATE_ADDRESSES) assert.equal(isPublicAddress(ip), false, ip);
});

// Range edges: an over-wide range check would refuse real sites.
test("isPublicAddress: public addresses, including just past a private range's edge, are public", () => {
  // One assertion per row; the message names the row that broke.
  for (const ip of PUBLIC_ADDRESSES) assert.equal(isPublicAddress(ip), true, ip);
});

// Trailing root dot, case, reserved suffixes, single labels and IP literals all count as private.
test("isBlockedHost: private names, root-dot and case variants, and IP literals are blocked", () => {
  // Each one must be refused before DNS is ever asked.
  for (const host of ["localhost.", "LOCALHOST", "db.internal.", "printer.local", "intranet", "127.0.0.1", "[::1]"]) {
    // The message names the host that slipped through.
    assert.equal(isBlockedHost(host), true, host);
  }
});

// The guard must not refuse the boards this pipeline actually reads.
test("isBlockedHost: ordinary public hostnames are not blocked", () => {
  // Real-shaped job-board hosts.
  for (const host of ["www.linkedin.com", "careers.example.com"]) assert.equal(isBlockedHost(host), false, host);
});

// A public-looking name that resolves to loopback (127.0.0.1.nip.io style) is refused pre-fetch.
test("fetchPublicPage: a name resolving to loopback is refused and never fetched", async () => {
  // The name itself passes isBlockedHost; only DNS reveals the target.
  const { deps, fetched } = fakeDeps({ hop: () => new Response(PAGE), dns: { "a.example": ["127.0.0.1"] } });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused, and the request never left.
  assert.equal(result.ok, false);
  assert.deepEqual(fetched, []);
});

// The connection may pick any address, so one private record poisons the whole name.
test("fetchPublicPage: one private address among public ones is enough to refuse", async () => {
  // Mixed A records.
  const { deps, fetched } = fakeDeps({ hop: () => new Response(PAGE), dns: { "a.example": ["8.8.8.8", "10.0.0.1"] } });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused without a request.
  assert.equal(result.ok, false);
  assert.deepEqual(fetched, []);
});

// No address (or DNS down) must fail closed, never fall through to fetch.
test("fetchPublicPage: a name with no addresses is refused and never fetched", async () => {
  // Empty resolution.
  const { deps, fetched } = fakeDeps({ hop: () => new Response(PAGE), dns: { "a.example": [] } });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused without a request.
  assert.equal(result.ok, false);
  assert.deepEqual(fetched, []);
});

// The happy path: one public hop, the body comes back verbatim.
test("fetchPublicPage: a public 200 page returns its html", async () => {
  // Default DNS is public.
  const { deps, fetched } = fakeDeps({ hop: () => new Response(PAGE, { status: 200 }) });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // The page, fetched once.
  assert.deepEqual(result, { ok: true, html: PAGE });
  assert.deepEqual(fetched, ["https://a.example/jobs/1"]);
});

// A relative Location resolves against the hop that sent it, then is followed.
test("fetchPublicPage: a relative redirect is resolved against the current hop and followed", async () => {
  // First hop redirects; the target serves the page.
  const { deps, fetched } = fakeDeps({ hop: (url) => (url === "https://a.example/jobs/1" ? redirect("/jobs/2") : new Response(PAGE)) });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Second hop requested at the absolute URL, and its page returned.
  assert.deepEqual(fetched, ["https://a.example/jobs/1", "https://a.example/jobs/2"]);
  assert.deepEqual(result, { ok: true, html: PAGE });
});

// An allowed host 302-ing to an internal name is the classic SSRF bypass.
test("fetchPublicPage: a redirect to an internal hostname is refused before it is fetched", async () => {
  // Every hop redirects inward; only the first may be fetched.
  const { deps, fetched, resolved } = fakeDeps({ hop: () => redirect("https://evil.internal/x") });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused after exactly one request; the internal name never reached DNS either.
  assert.equal(result.ok, false);
  assert.equal(fetched.length, 1);
  assert.deepEqual(resolved, ["a.example"]);
});

// A downgrade to http is refused by the same rule as a pasted http link.
test("fetchPublicPage: a redirect downgrading to http is refused", async () => {
  // Redirect to plain http.
  const { deps, fetched } = fakeDeps({ hop: () => redirect("http://b.example/x") });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused after one request.
  assert.equal(result.ok, false);
  assert.equal(fetched.length, 1);
});

// A redirect to a public-looking name that resolves to the cloud metadata address.
test("fetchPublicPage: a redirect to a host resolving to 169.254.169.254 is refused before hop two", async () => {
  // Only b.example is poisoned in DNS.
  const { deps, fetched } = fakeDeps({ hop: () => redirect("https://b.example/x"), dns: { "b.example": ["169.254.169.254"] } });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused; the metadata host was never requested.
  assert.equal(result.ok, false);
  assert.deepEqual(fetched, ["https://a.example/jobs/1"]);
});

// A 3xx with nothing to follow is a dead end, not a page.
test("fetchPublicPage: a redirect without a Location is refused", async () => {
  // 302 with no header.
  const { deps } = fakeDeps({ hop: () => redirect() });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Refused.
  assert.equal(result.ok, false);
});

// A loop must stop at the cap: the first request plus MAX_REDIRECTS hops, then give up.
test("fetchPublicPage: a redirect loop stops after MAX_REDIRECTS + 1 requests", async () => {
  // Always 302 back to itself.
  const { deps, fetched } = fakeDeps({ hop: () => redirect("https://a.example/loop") });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/loop", deps);
  // Refused for the right reason, after exactly the allowed number of requests.
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /too many redirects/);
  assert.equal(fetched.length, MAX_REDIRECTS + 1);
});

// fetchHop's null means 404, which must surface as a dead link.
test("fetchPublicPage: a null hop is reported as page not found", async () => {
  // The seam's 404 answer.
  const { deps } = fakeDeps({ hop: () => null });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // The exact refusal.
  assert.deepEqual(result, { ok: false, reason: "page not found" });
});

// A huge page is cut at the byte cap, never buffered whole.
test("fetchPublicPage: a body larger than MAX_PAGE_BYTES is truncated to the cap", async () => {
  // ASCII, so bytes equal characters.
  const big = "a".repeat(MAX_PAGE_BYTES + 1000);
  // Served by one public hop.
  const { deps } = fakeDeps({ hop: () => new Response(big) });
  // The pasted link.
  const result = await fetchPublicPage("https://a.example/jobs/1", deps);
  // Kept, but exactly at the cap.
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.html.length : -1, MAX_PAGE_BYTES);
});

// Second security review (2026-10-31): IPv6 forms that embed or route to a v4 address are not public.
test("isPublicAddress: 6to4, Teredo, NAT64 local-use and discard prefixes are not public", () => {
  // 6to4 2002::/16 can wrap 127.0.0.1 (2002:7f00:1::).
  assert.equal(isPublicAddress("2002:7f00:1::1"), false);
  // Teredo 2001:0::/32, written with and without the zero group compressed.
  assert.equal(isPublicAddress("2001:0:4136:e378::1"), false);
  // Same prefix, compressed form.
  assert.equal(isPublicAddress("2001::1"), false);
  // NAT64 local-use 64:ff9b:1::/48.
  assert.equal(isPublicAddress("64:ff9b:1::a00:1"), false);
  // Discard-only 100::/64.
  assert.equal(isPublicAddress("100::1"), false);
  // A real 2001: global address (Google DNS) is still public: the Teredo rule is not a 2001: blanket.
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});
