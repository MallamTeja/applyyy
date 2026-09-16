// Tests for apply-URL resolution from untrusted post text.
//
// THE THREAT, STATED PLAINLY. A Tier-2 sighting is a LinkedIn post whose body was written
// by a stranger. Whatever URL we lift out of it becomes the link shown to Teja on the
// dashboard and the link he may click. The previous implementation took the FIRST http(s)
// string anywhere in the body, with no host check and no scheme check beyond the prefix —
// so the poster chose the destination, not us.
//
// WHY THIS MATTERS MORE HERE THAN IN THE UPSTREAM EQUIVALENT: upstream's host check guards
// a human-supervised drafting step, where a person has read the posting. Ours guards an
// unattended discovery path. The URL is extracted, stored and rendered without any human
// having read the post it came from.
//
// EVERY CASE BELOW IS ADVERSARIAL BY DESIGN. A test suite for this that only checks the
// happy path would pass against the broken implementation it is meant to replace.
import { test } from "node:test";
// Strict, so `false` never quietly compares equal to `undefined`.
import assert from "node:assert/strict";
// The unit under test.
import { isTrustedApplyHost, resolveApplyUrl } from "./apply-url.ts";

// A known-good LinkedIn permalink, always available as the last resort.
const POST_URL = "https://www.linkedin.com/posts/jane-doe_hiring-activity-123";

// Resolve with only the fields a given test varies.
function resolve(postText: string, structuredUrl?: string) {
  return resolveApplyUrl({ postText, fallbackUrl: POST_URL, ...(structuredUrl === undefined ? {} : { structuredUrl }) });
}

// --- host trust, which is where the look-alike attacks land ---

// The legitimate shapes: the apex itself and any subdomain of it.
test("a real ATS apex and its subdomains are trusted", () => {
  assert.equal(isTrustedApplyHost("greenhouse.io"), true);
  assert.equal(isTrustedApplyHost("boards.greenhouse.io"), true);
  assert.equal(isTrustedApplyHost("jobs.lever.co"), true);
  assert.equal(isTrustedApplyHost("jobs.ashbyhq.com"), true);
});

// PREFIX LOOK-ALIKE. `evil-greenhouse.io` is a different domain that reads like ours at a
// glance. A naive `includes("greenhouse.io")` accepts it, which is why the check is an
// exact match or a dot-anchored suffix rather than a substring.
test("a prefix look-alike host is rejected", () => {
  assert.equal(isTrustedApplyHost("evil-greenhouse.io"), false);
  assert.equal(isTrustedApplyHost("notlever.co"), false);
});

// SUFFIX SPOOF. The apex appears in the host but the registrable domain is the attacker's.
// This is the one a `startsWith`/`includes` check misses most often.
test("a suffix-spoofed host is rejected", () => {
  assert.equal(isTrustedApplyHost("boards.greenhouse.io.evil.com"), false);
  assert.equal(isTrustedApplyHost("jobs.lever.co.attacker.net"), false);
});

// An ordinary unrelated host has no business being an apply link.
test("an unrelated host is not trusted", () => {
  assert.equal(isTrustedApplyHost("medium.com"), false);
  assert.equal(isTrustedApplyHost("bit.ly"), false);
});

// --- resolution order ---

// The structured field is produced by our own extraction rather than scraped out of prose,
// so it outranks anything found in the body.
test("a structured apply URL outranks anything in the post body", () => {
  const result = resolve("Apply here https://boards.greenhouse.io/other/jobs/1", "https://jobs.lever.co/acme/abc");
  assert.equal(result.url, "https://jobs.lever.co/acme/abc");
  assert.equal(result.verified, true);
});

// A genuine ATS link in the body is the normal case and must be picked up.
test("an ATS link in the post body is used and marked verified", () => {
  const result = resolve("We are hiring! Apply: https://boards.greenhouse.io/acme/jobs/42 Thanks");
  assert.equal(result.url, "https://boards.greenhouse.io/acme/jobs/42");
  assert.equal(result.verified, true);
});

// THE CASE THAT BREAKS "TAKE THE FIRST URL". Posters routinely open with a link to their
// blog, newsletter or company site before getting to the apply link. Taking the first URL
// sends Teja to the wrong place while looking entirely successful.
test("an unrelated first URL is skipped in favour of a later ATS link", () => {
  const text = "Read about our culture https://medium.com/@acme/why-we-build then apply https://jobs.ashbyhq.com/acme/xyz";
  const result = resolve(text);
  assert.equal(result.url, "https://jobs.ashbyhq.com/acme/xyz");
});

// --- failing visibly rather than inventing ---

// No URL at all is common — "DM me your resume" posts have none. The post permalink is a
// truthful fallback, but it is NOT an apply URL and must not claim to be.
test("a post with no URL falls back to the permalink and is NOT marked verified", () => {
  const result = resolve("Hiring a backend engineer. DM me your resume.");
  assert.equal(result.url, POST_URL);
  assert.equal(result.verified, false);
});

// A post whose only links are untrusted must ALSO fall back rather than using them. This is
// the test that stops the fix from being cosmetic: rejecting a bad host is only useful if
// we then decline to use it.
test("a post whose only URLs are untrusted falls back rather than using them", () => {
  const result = resolve("Apply via https://evil-greenhouse.io/acme/jobs/1 today");
  assert.equal(result.url, POST_URL);
  assert.equal(result.verified, false);
});

// A structured URL is trusted more, but it is still not a licence to accept a hostile
// scheme or an unparseable string.
test("a structured URL that is not http(s) is rejected", () => {
  const result = resolve("nothing here", "javascript:alert(1)");
  assert.equal(result.url, POST_URL);
  assert.equal(result.verified, false);
});

// --- parsing hygiene ---

// THE GREEDY-MATCH BUG. `[^\s]+` runs to the next whitespace, so a link at the end of a
// sentence swallows the full stop and the resulting URL 404s. Punctuation is stripped from
// the end, but a legitimate trailing slash is not.
test("trailing sentence punctuation is stripped from a matched URL", () => {
  const result = resolve("Apply at https://boards.greenhouse.io/acme/jobs/42.");
  assert.equal(result.url, "https://boards.greenhouse.io/acme/jobs/42");
});

test("a closing bracket around a URL is not swallowed into it", () => {
  const result = resolve("Details (https://jobs.lever.co/acme/abc) below");
  assert.equal(result.url, "https://jobs.lever.co/acme/abc");
});

// USERINFO TRICK. `https://greenhouse.io@evil.com/x` has a HOST of evil.com — everything
// before the @ is credentials. A host check done by string inspection rather than by URL
// parsing reads "greenhouse.io" here and accepts it.
test("a userinfo-disguised host is rejected", () => {
  const result = resolve("Apply https://greenhouse.io@evil.com/jobs/1 now");
  assert.equal(result.url, POST_URL);
  assert.equal(result.verified, false);
});

// A reason must always be present, so a dashboard can explain an unverified link rather
// than showing one with no provenance.
test("every resolution carries a reason explaining the choice", () => {
  assert.notEqual(resolve("Hiring, DM me.").reason.length, 0);
  assert.notEqual(resolve("Apply https://boards.greenhouse.io/acme/jobs/42").reason.length, 0);
});
