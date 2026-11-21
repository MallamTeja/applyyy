// Tests for the iCIMS adapter (icims.ts), driven by pages recorded live on 2026-11-21
// (careers-apac-atlassian, careers-healthedge, indiacareers-symplr; GET only, robots-checked).
//
// THE SHAPE UNDER TEST: an iCIMS board is read as pages through the shared loop. Page one
// is the tenant's sitemap.xml (the only listing Atlassian serves: its HTML listing is a JS
// redirect to atlassian.com). Every later page is ONE job's detail page, whose JSON-LD
// JobPosting carries the title, location, description and date. The ids still to read
// travel in the page URL's fragment, which fetch never sends.
//
// THE TESTS THAT MATTER MOST are the refusals (orch conditions, 2026-11-21): a detail page
// without a usable JobPosting is a COUNTED SKIP, never a job with a blank title or
// location; a sitemap that is not a sitemap fails the board instead of reading as empty;
// a cursor that cannot be read stalls (fails) instead of ending the board early.
// The node:test runner, matching every other suite in supabase/functions.
import { test } from "node:test";
// Strict, so `undefined` never quietly compares equal to `null`.
import assert from "node:assert/strict";
// The unit under test, plus its token parser and page cap.
import { ICIMS_MAX_PAGES, icimsAdapter, parseIcimsToken } from "./icims.ts";
// The shared page loop both scouts drive every board through.
import { collectBoardPages, MAX_BOARD_PAGES } from "../../ats/registry.ts";

// The Atlassian APAC tenant, the first board this adapter exists for.
const TOKEN = "careers-apac-atlassian";
// Its origin, as every built URL must start.
const ORIGIN = "https://careers-apac-atlassian.icims.com";

// The recorded sitemap's head, verbatim (the live file lists `/jobs/intro` plus 34 jobs).
// The %2c slug and the intro page are both kept: the parser must read ids, not slugs, and
// must ignore non-job locs.
const SITEMAP =
  "<?xml version='1.0' encoding='utf-8'?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">" +
  `<url><loc>${ORIGIN}/jobs/intro</loc></url>` +
  `<url><loc>${ORIGIN}/jobs/27181/principal-forward-deployed-engineer/job</loc><lastmod>2026-11-20T04:46:45-05:00</lastmod></url>` +
  `<url><loc>${ORIGIN}/jobs/26751/senior-software-engineer---trusted-data-platform/job</loc><lastmod>2026-11-20T03:04:05-05:00</lastmod></url>` +
  `<url><loc>${ORIGIN}/jobs/25611/manager%2c-account-executives%2c-mid-market/job</loc><lastmod>2026-11-20T02:14:12-05:00</lastmod></url>` +
  "</urlset>";

// Atlassian's recorded JSON-LD for job 27181, verbatim except the description, which is
// cut to its first paragraph (the live one is ~8k characters of the same markup).
const ATLASSIAN_27181 = {
  validThrough: "2027-09-24T04:00:00.000Z",
  employmentType: "OTHER",
  "@type": "JobPosting",
  description: "<h2>Overview</h2>\n<p><strong>Working at Atlassian</strong></p>\n<p>Atlassians can choose where they work.</p>",
  directApply: true,
  title: "Principal Forward Deployed Engineer",
  "@context": "http://schema.org",
  url: `${ORIGIN}/jobs/27181/principal-forward-deployed-engineer/job`,
  jobLocationType: "TELECOMMUTE",
  hiringOrganization: { "@type": "Organization", name: "Atlassian", sameAs: "https://www.atlassian.com/company/careers" },
  jobLocation: [{ address: { addressCountry: "IN", streetAddress: "UNAVAILABLE", "@type": "PostalAddress", postalCode: "560071", addressLocality: "Bengaluru", addressRegion: "UNAVAILABLE", postOfficeBoxNumber: "UNAVAILABLE" }, "@type": "Place" }],
  datePosted: "2026-09-24T04:00:00.000Z",
  occupationalCategory: "Engineering",
};

// symplr's recorded JSON-LD, verbatim except the description: a real region, FULL_TIME.
const SYMPLR_2597 = {
  hiringOrganization: { "@type": "Organization", name: "symplr", sameAs: "https://www.symplr.com" },
  validThrough: "2027-10-16T04:00:00.000Z",
  jobLocation: [{ address: { addressCountry: "IN", streetAddress: "Prestige Technostar, Doddanakundi Industrial Area 2, Phase 1", "@type": "PostalAddress", postalCode: "560048", addressLocality: "Bangalore", addressRegion: "KA", postOfficeBoxNumber: "UNAVAILABLE" }, "@type": "Place" }],
  employmentType: "FULL_TIME",
  "@type": "JobPosting",
  description: "<h2>Overview</h2>\n<p>Software Engineers are responsible for the design.</p>",
  directApply: true,
  datePosted: "2026-10-16T04:00:00.000Z",
  title: "Software Engineer (Java)",
  occupationalCategory: "Engineering",
  "@context": "http://schema.org",
  url: "https://indiacareers-symplr.icims.com/jobs/2597/software-engineer-%28java%29/job",
};

// A detail page as iCIMS serves it with ?in_iframe=1: one JSON-LD script in ordinary HTML.
// The script tag is the recorded one, byte for byte.
const detailPage = (jsonLd: unknown): string =>
  `<!DOCTYPE html><html><head><title>Job</title><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><div class="iCIMS_JobContent">…</div></body></html>`;

// Parse one page and return the result, typed loosely for the assertions.
const parseAt = (payload: unknown, token: string = TOKEN) => icimsAdapter.parse(payload, token);

// --- the board token -------------------------------------------------------------------

test("the token is the tenant subdomain and nothing else", () => {
  // The real tenants parse to their own origin.
  assert.deepEqual(parseIcimsToken(TOKEN), { tenant: TOKEN, origin: ORIGIN });
  assert.equal(parseIcimsToken("indiacareers-symplr")?.origin, "https://indiacareers-symplr.icims.com");
  // A pasted host, a URL, a path or a dot would point the scout somewhere else: refused.
  for (const bad of ["", "careers-apac-atlassian.icims.com", "https://careers-apac-atlassian.icims.com", "a/b", "evil.com#", "-lead", "UPPER", "a".repeat(64)]) {
    // Every one of them is null, never a best guess.
    assert.equal(parseIcimsToken(bad), null, bad);
  }
});

test("page one is the tenant's sitemap.xml", () => {
  // The only listing every tenant serves (Atlassian's HTML listing redirects away).
  assert.equal(icimsAdapter.buildRequestUrl(TOKEN), `${ORIGIN}/sitemap.xml`);
  // Pages are text, not JSON: the transport must hand the parser the raw body.
  assert.equal(icimsAdapter.payloadFormat, "text");
  // Provider and page cap are what the registry and the loop read.
  assert.equal(icimsAdapter.provider, "icims");
  assert.equal(icimsAdapter.maxPages, ICIMS_MAX_PAGES);
});

// --- the sitemap page ------------------------------------------------------------------

test("the sitemap page itself yields no postings, and its job ids become the cursor", () => {
  // Nothing is posted from the sitemap: it carries neither title nor location.
  assert.deepEqual(parseAt(SITEMAP), { ok: true, postings: [], skipped: [] });
  // The first job, by id only (the id-only path serves the same page, probed live), with the rest in the fragment.
  assert.equal(
    icimsAdapter.nextPageUrl!(TOKEN, SITEMAP, `${ORIGIN}/sitemap.xml`),
    `${ORIGIN}/jobs/27181/job?in_iframe=1#rest=26751,25611`,
  );
});

test("a sitemap with no job locs ends the board (an empty board is not an error)", () => {
  // Only the intro page, as a tenant with no openings would list.
  const empty = `<?xml version='1.0' encoding='utf-8'?><urlset><url><loc>${ORIGIN}/jobs/intro</loc></url></urlset>`;
  // No next page: the loop stores zero postings and the went-empty guard judges it.
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, empty, `${ORIGIN}/sitemap.xml`), null);
});

test("a sitemap page that is not a sitemap STALLS the loop instead of reading as an empty board", () => {
  // A soft-200 HTML page where the sitemap should be (the 'gone: … dc409' page, a login wall).
  const html = "<html><body>gone: careers-x : dc409</body></html>";
  // The cursor stays put, which collectBoardPages fails as "did not advance" (§6: never an empty board).
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, html, `${ORIGIN}/sitemap.xml`), `${ORIGIN}/sitemap.xml`);
});

test("job locs on another host are not followed", () => {
  // A sitemap naming a stranger's host must not send the scout there.
  const foreign = `<urlset><url><loc>https://evil.example/jobs/1/x/job</loc></url><url><loc>${ORIGIN}/jobs/7/ok/job</loc></url></urlset>`;
  // Only the tenant's own job is read.
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, foreign, `${ORIGIN}/sitemap.xml`), `${ORIGIN}/jobs/7/job?in_iframe=1#rest=`);
});

// --- the detail pages --------------------------------------------------------------------

test("a detail page becomes one posting from its JSON-LD JobPosting", () => {
  // The recorded Atlassian page.
  const result = parseAt(detailPage(ATLASSIAN_27181));
  // Parsed, one posting, nothing skipped.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.postings.length, 1);
  assert.deepEqual(result.skipped, []);
  // The posting's fields.
  const p = result.postings[0]!;
  // The id is read from the canonical URL (iCIMS JSON-LD has no `identifier`).
  assert.equal(p.atsJobId, "27181");
  assert.equal(p.title, "Principal Forward Deployed Engineer");
  // "UNAVAILABLE" placeholders are dropped and the ISO country is spelled out, so the work-auth
  // gate never reads a literal "UNAVAILABLE" region or an ambiguous "IN" (Indiana).
  assert.equal(p.locationRaw, "Bengaluru, India");
  // The canonical page is the submit target.
  assert.equal(p.applyUrl, `${ORIGIN}/jobs/27181/principal-forward-deployed-engineer/job`);
  // TELECOMMUTE is the structured remote flag.
  assert.equal(p.workArrangement, "remote");
  // "OTHER" is not a type we can name; declining beats guessing.
  assert.equal(p.employmentType, "unknown");
  // HTML stripped to text.
  assert.match(p.descriptionRaw ?? "", /Working at Atlassian/);
  assert.doesNotMatch(p.descriptionRaw ?? "", /<p>/);
  // A genuine ISO publish date, judged by the shared strict ISO reader.
  assert.deepEqual(p.postedAtInput, { source: "remote_feed", published: "2026-09-24T04:00:00.000Z" });
});

test("a real region and FULL_TIME are kept (symplr)", () => {
  // The recorded symplr page, parsed against its own tenant.
  const result = parseAt(detailPage(SYMPLR_2597), "indiacareers-symplr");
  // One posting.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const p = result.postings[0]!;
  // City, region, country; the street address is not location prose.
  assert.equal(p.locationRaw, "Bangalore, KA, India");
  // FULL_TIME's underscore is read as the space the classifier expects.
  assert.equal(p.employmentType, "full_time");
  // Not TELECOMMUTE and no "remote" prose: onsite or unknown, never remote.
  assert.notEqual(p.workArrangement, "remote");
});

// Live dry run 2026-11-21: Atlassian's Singapore jobs carry addressRegion "01" and read as "01, Singapore".
test("a numeric region code is dropped (Singapore's '01' is not location prose)", () => {
  // The live shape: region "01", country SG.
  const sg = { ...ATLASSIAN_27181, jobLocationType: undefined, jobLocation: [{ address: { addressLocality: "UNAVAILABLE", addressRegion: "01", addressCountry: "SG" } }] };
  // Parsed into one posting.
  const result = parseAt(detailPage(sg));
  // The country alone.
  assert.equal(result.ok && result.postings[0]!.locationRaw, "Singapore");
});

test("several places are joined with ';', the separator the work-auth gate splits on", () => {
  // Two offices, one of them a duplicate.
  const two = { ...SYMPLR_2597, jobLocation: [SYMPLR_2597.jobLocation[0], { address: { addressLocality: "Hyderabad", addressCountry: "IN" } }, SYMPLR_2597.jobLocation[0]] };
  // Parsed against its own tenant.
  const result = parseAt(detailPage(two), "indiacareers-symplr");
  // Each place once, in order.
  assert.equal(result.ok && result.postings[0]!.locationRaw, "Bangalore, KA, India; Hyderabad, India");
});

// Condition (2): never a job with a blank title or location.
test("a detail page without a usable JobPosting is a counted skip, never a blank job", () => {
  // Each of these is a page iCIMS could plausibly serve; none may produce a posting.
  const cases: Array<[string, string]> = [
    // No JSON-LD at all (the outer page, an error page).
    ["no JSON-LD", "<html><body>Sorry</body></html>"],
    // Malformed JSON inside the script.
    ["malformed JSON-LD", '<script type="application/ld+json">{"@type":"JobPosting",</script>'],
    // JSON-LD of another type.
    ["not a JobPosting", detailPage({ "@type": "Organization", name: "Atlassian" })],
    // A JobPosting with no title, or a blank one.
    ["no title", detailPage({ ...ATLASSIAN_27181, title: undefined })],
    ["blank title", detailPage({ ...ATLASSIAN_27181, title: "   " })],
    // A JobPosting whose every location field is a placeholder, and not remote.
    ["no location", detailPage({ ...ATLASSIAN_27181, jobLocationType: undefined, jobLocation: [{ address: { addressLocality: "UNAVAILABLE", addressCountry: "UNAVAILABLE" } }] })],
    // A canonical URL on another host or of another shape: no trustworthy id or submit target.
    ["foreign url", detailPage({ ...ATLASSIAN_27181, url: "https://evil.example/jobs/27181/x/job" })],
    ["no url", detailPage({ ...ATLASSIAN_27181, url: undefined })],
  ];
  // Every case parses (the board is not failed by one bad page) with zero postings and one skip.
  for (const [name, page] of cases) {
    // One page.
    const result = parseAt(page);
    // Parsed, so the other jobs on the board still land.
    assert.equal(result.ok, true, name);
    if (!result.ok) continue;
    // No posting at all.
    assert.equal(result.postings.length, 0, name);
    // Counted, so the health page shows how many were dropped.
    assert.equal(result.skipped.length, 1, name);
  }
});

test("a remote job with no address keeps 'Remote' as its location", () => {
  // TELECOMMUTE with only placeholders: remote is the one true location fact.
  const page = detailPage({ ...ATLASSIAN_27181, jobLocation: [{ address: { addressLocality: "UNAVAILABLE" } }] });
  // Parsed into one posting.
  const result = parseAt(page);
  // Location prose the work-auth gate reads as remote.
  assert.equal(result.ok && result.postings[0]!.locationRaw, "Remote");
});

test("parse refuses a missing token and a non-text payload", () => {
  // Without the token no URL can be checked against the tenant.
  assert.equal(icimsAdapter.parse(SITEMAP).ok, false);
  // A decoded JSON object means the transport ignored payloadFormat: fail loudly.
  assert.equal(parseAt({ jobs: [] }).ok, false);
});

test("the identity check is declared inapplicable (the sitemap names no company)", () => {
  // Null is the contract's declared "no identity field", like lever and ashby.
  assert.equal(icimsAdapter.readReportedIdentity(SITEMAP), null);
});

// --- the cursor ----------------------------------------------------------------------------

test("each detail page names the next id and the remainder; the last ends the board", () => {
  // Middle of the board.
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, "", `${ORIGIN}/jobs/27181/job?in_iframe=1#rest=26751,25611`), `${ORIGIN}/jobs/26751/job?in_iframe=1#rest=25611`);
  // Second to last.
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, "", `${ORIGIN}/jobs/26751/job?in_iframe=1#rest=25611`), `${ORIGIN}/jobs/25611/job?in_iframe=1#rest=`);
  // Last: an empty remainder.
  assert.equal(icimsAdapter.nextPageUrl!(TOKEN, "", `${ORIGIN}/jobs/25611/job?in_iframe=1#rest=`), null);
});

test("an unreadable cursor returns the current URL (the loop fails it), never null", () => {
  // Each is a URL the adapter did not build.
  for (const url of [
    // No fragment at all on a detail page.
    `${ORIGIN}/jobs/1/job?in_iframe=1`,
    // Garbage in the remainder.
    `${ORIGIN}/jobs/1/job?in_iframe=1#rest=2,x`,
    // Another tenant's host.
    "https://careers-other.icims.com/jobs/1/job?in_iframe=1#rest=2",
    // A path that is neither sitemap nor detail.
    `${ORIGIN}/jobs/search?ss=1`,
  ]) {
    // Stays put, so collectBoardPages reports "did not advance" instead of a short board.
    assert.equal(icimsAdapter.nextPageUrl!(TOKEN, "", url), url, url);
  }
});

// --- the whole board through the shared loop --------------------------------------------------

test("a whole board: sitemap, then one detail page per job, through collectBoardPages", async () => {
  // Every URL the loop asks for, in order, to prove one request per page and no other host.
  const asked: string[] = [];
  // Detail pages by id: two good, one without JSON-LD (a counted skip).
  const pages: Record<string, string> = {
    [`${ORIGIN}/sitemap.xml`]: SITEMAP,
    [`${ORIGIN}/jobs/27181/job?in_iframe=1`]: detailPage(ATLASSIAN_27181),
    [`${ORIGIN}/jobs/26751/job?in_iframe=1`]: "<html>no ld</html>",
    [`${ORIGIN}/jobs/25611/job?in_iframe=1`]: detailPage({ ...ATLASSIAN_27181, title: "Manager, Account Executives", url: `${ORIGIN}/jobs/25611/manager%2c-account-executives%2c-mid-market/job` }),
  };
  // The fake transport strips the fragment exactly as fetch does, and checks the format it was told.
  const result = await collectBoardPages(icimsAdapter, TOKEN, async (url, body, format) => {
    // fetch never sends the fragment.
    const sent = url.split("#")[0]!;
    // Recorded for the order assertion.
    asked.push(sent);
    // A GET (no body) asking for text.
    assert.equal(body, undefined);
    assert.equal(format, "text");
    // The recorded page, or a loud failure for an unexpected URL.
    const page = pages[sent];
    if (page === undefined) throw new Error(`unexpected URL ${sent}`);
    return page;
  });
  // All pages read, sitemap first, ids in sitemap order.
  assert.deepEqual(asked, Object.keys(pages));
  // Two postings, one counted skip.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.postings.map((p) => p.atsJobId), ["27181", "25611"]);
  assert.equal(result.skipped.length, 1);
  // The identity guard sees the sitemap.
  assert.equal(result.firstPayload, SITEMAP);
});

test("iCIMS raises the loop's page cap for itself only", async () => {
  // A sitemap with more jobs than the default cap but within iCIMS's.
  const ids = Array.from({ length: MAX_BOARD_PAGES + 5 }, (_, i) => 1000 + i);
  const big = `<urlset>${ids.map((id) => `<url><loc>${ORIGIN}/jobs/${id}/j/job</loc></url>`).join("")}</urlset>`;
  // Every detail page is the same good posting with its own URL.
  const result = await collectBoardPages(icimsAdapter, TOKEN, async (url) => {
    // The sitemap.
    if (url.endsWith("/sitemap.xml")) return big;
    // A detail page whose canonical URL carries the requested id.
    const id = /\/jobs\/(\d+)\//.exec(url)![1];
    return detailPage({ ...ATLASSIAN_27181, url: `${ORIGIN}/jobs/${id}/j/job` });
  });
  // The whole board, past the default cap of 20.
  assert.equal(result.ok && result.postings.length, ids.length);
  // And a board past iCIMS's own cap fails rather than truncating.
  const huge = `<urlset>${Array.from({ length: ICIMS_MAX_PAGES }, (_, i) => `<url><loc>${ORIGIN}/jobs/${i + 1}/j/job</loc></url>`).join("")}</urlset>`;
  const capped = await collectBoardPages(icimsAdapter, TOKEN, async (url) => (url.endsWith("/sitemap.xml") ? huge : detailPage(ATLASSIAN_27181)));
  // Refused, with the cap named.
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.match(capped.reason, new RegExp(`page cap of ${ICIMS_MAX_PAGES}`));
});
