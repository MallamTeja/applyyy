// Table-driven tests for the strict URL shape check. No network.
import { test } from "node:test";
// Strict assertions so a missing key never equals an undefined one.
import assert from "node:assert/strict";
import { extractUrls, parseJobUrl } from "./urls.ts";

// A UUID reused by the lever/ashby rows.
const UUID = "123e4567-e89b-12d3-a456-426614174000";

// Each row: input, then the provider/token/id expected when accepted.
const ACCEPT: ReadonlyArray<[string, string, string, string]> = [
  // Current Greenhouse host.
  ["https://job-boards.greenhouse.io/acme/jobs/12345", "greenhouse", "acme", "12345"],
  // Legacy Greenhouse host with a trailing slash and a tracking query.
  ["https://boards.greenhouse.io/acme/jobs/12345/?gh_src=x", "greenhouse", "acme", "12345"],
  // Lever posting page.
  [`https://jobs.lever.co/acme/${UUID}`, "lever", "acme", UUID],
  // Lever apply page for the same posting.
  [`https://jobs.lever.co/acme/${UUID}/apply`, "lever", "acme", UUID],
  // Ashby posting page.
  [`https://jobs.ashbyhq.com/acme/${UUID}`, "ashby", "acme", UUID],
];
// One test per accepted row so a failure names the URL.
for (const [url, provider, token, jobId] of ACCEPT) {
  test(`accepts ${url}`, () => {
    // The result must be ok with exactly the extracted facts.
    assert.deepEqual(parseJobUrl(url), { ok: true, parsed: { provider, token, jobId } });
  });
}

// Rows of [input, reason]; includes the lookalike-host attacks.
const REJECT: ReadonlyArray<[string, string]> = [
  // Suffix lookalike: contains the real host as a prefix label.
  ["https://job-boards.greenhouse.io.evil.com/acme/jobs/1", "host_not_allowed"],
  // Embedded lookalike: real domain name as a subdomain of an attacker domain.
  ["https://greenhouse.io.evil.com/acme/jobs/1", "host_not_allowed"],
  // A subdomain of an allowed host is not the allowed host.
  ["https://evil.boards.greenhouse.io/acme/jobs/1", "host_not_allowed"],
  // Userinfo trick: the real host appears before an @.
  ["https://boards.greenhouse.io@evil.com/acme/jobs/1", "userinfo_or_port"],
  // Plain http.
  ["http://boards.greenhouse.io/acme/jobs/1", "not_https"],
  // Non-default port.
  ["https://boards.greenhouse.io:8443/acme/jobs/1", "userinfo_or_port"],
  // Right host, board index page rather than a posting.
  ["https://boards.greenhouse.io/acme", "path_shape_mismatch"],
  // Greenhouse ids must be numeric.
  ["https://boards.greenhouse.io/acme/jobs/abc", "path_shape_mismatch"],
  // Lever ids must be UUIDs.
  ["https://jobs.lever.co/acme/not-a-uuid", "path_shape_mismatch"],
  // Path traversal in the token position.
  [`https://jobs.lever.co/../${UUID}`, "path_shape_mismatch"],
  // A host that is simply not an ATS.
  ["https://example.com/acme/jobs/1", "host_not_allowed"],
  // Not a URL at all.
  ["not a url", "not_a_url"],
  // Dangerous scheme.
  ["javascript:alert(1)", "not_https"],
];
// One test per rejected row.
for (const [url, reason] of REJECT) {
  test(`rejects ${url} (${reason})`, () => {
    // Reason is part of the contract: the UI shows it.
    assert.deepEqual(parseJobUrl(url), { ok: false, reason });
  });
}

test("extractUrls strips trailing punctuation and markdown wrappers", () => {
  // Prose, a markdown link and a list item: the three shapes models emit.
  const text = `See https://a.example/x. Also [link](https://b.example/y) and\n- https://c.example/z,`;
  // Order of appearance is preserved.
  assert.deepEqual(extractUrls(text), ["https://a.example/x", "https://b.example/y", "https://c.example/z"]);
});
