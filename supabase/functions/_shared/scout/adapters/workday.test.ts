// Tests for the Workday adapter (workday.ts) and the two page-loop extensions it needs.
//
// THE TESTS THAT MATTER MOST HERE are the refusals: a malformed token, a garbage
// cursor, a payload without postings, a board at Workday's 2000 cap. Workday's quirks
// (proved live on 2026-11-01 against a non-candidate tenant, nvidia.wd5) make every one
// of them a way to store a truncated board as if it were whole:
//   - the list endpoint is POST-only (GET answers 400), so the offset lives in a body;
//   - `total` arrives on page ONE only (later pages say `total: 0`);
//   - a page is at most 20 postings (limit 50 answers 400);
//   - `total` caps at 2000, and offset 2000 wraps back to page one.
// The node:test runner, matching every other suite in supabase/functions.
import { test } from "node:test";
// Strict, so `undefined` never quietly compares equal to `null`.
import assert from "node:assert/strict";
// The unit under test, plus its token parser (exported so the seed snippet's tokens can
// be held to the same closed shape the adapter polls with).
import { parseWorkdayToken, workdayAdapter } from "./workday.ts";
// The shared page loop the Workday adapter is driven by in both scouts.
import { collectBoardPages, MAX_BOARD_PAGES } from "../../ats/registry.ts";
// Types only: the fake adapter in the loop tests is shaped against the real contract.
import type { AtsAdapter } from "../../ats/types.ts";

// A board token in the plain shape (no facet) and the endpoint it must produce.
const TOKEN = "mastercard.wd1/CorporateCareers";
// The cxs list endpoint a real careers page POSTs to, for that token.
const ENDPOINT = "https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/jobs";
// Two real-shaped 32-hex facet ids (Workday location ids are this shape).
const ID_A = "8eab563831bf10acbc722e4859721571";
// The second id, so the multi-id facet form is exercised.
const ID_B = "8eab563831bf10acb97b7fba5feff76e";

// One list page as the live API ships it: `total` (page one only), `jobPostings`.
function wdPage(total: number, ids: readonly string[]) {
  // Built per call so no test can mutate another test's fixture.
  return {
    // Page one carries the real total; later pages carry 0, as the live API does.
    total,
    // Each posting in the list shape: no description, a relative externalPath.
    jobPostings: ids.map((id) => ({
      // The posting title.
      title: `Senior Software Engineer ${id}`,
      // Relative to the site; the adapter must make it absolute.
      externalPath: `/job/Pune-India/Senior-Software-Engineer_R-${id}`,
      // Workday's own location prose ("2 Locations" when it has several).
      locationsText: "Pune, India",
      // Relative date prose, the only date the list endpoint offers.
      postedOn: "Posted 3 Days Ago",
      // The requisition id, which Workday shows but does not guarantee.
      bulletFields: [`R-${id}`],
    })),
  };
}

// Twenty ids for one full page, prefixed so each page's postings are distinct.
function fullPage(prefix: string): string[] {
  // Exactly Workday's page size.
  return Array.from({ length: 20 }, (_, i) => `${prefix}${i}`);
}

// --- the board token: a closed shape, never a lenient split ---------------------------

test("workday token parses tenant, wd number and site", () => {
  // The plain form: no India facet.
  assert.deepEqual(parseWorkdayToken(TOKEN), { tenant: "mastercard", wd: 1, site: "CorporateCareers", facet: null });
});

test("workday token carries an optional facet with one or more ids", () => {
  // A single id (the country-facet tenants).
  assert.deepEqual(parseWorkdayToken(`visa.wd5/Visa?locationCountry=${ID_A}`), {
    tenant: "visa", wd: 5, site: "Visa", facet: { param: "locationCountry", ids: [ID_A] },
  });
  // Several ids (the city-facet tenants, which have no country facet), and a facet
  // parameter with the hyphens and underscores Salesforce's really has.
  assert.deepEqual(parseWorkdayToken(`salesforce.wd12/External_Career_Site?CF_-_Country=${ID_A},${ID_B}`), {
    tenant: "salesforce", wd: 12, site: "External_Career_Site", facet: { param: "CF_-_Country", ids: [ID_A, ID_B] },
  });
});

test("workday token rejects every malformed shape", () => {
  // Each of these would build a wrong or attacker-shaped request if split leniently.
  const bad = [
    // Empty: a blank watchlist cell.
    "",
    // Tenant only: no wd number or site to build a host and path from.
    "mastercard",
    // No site: the cxs path needs one.
    "mastercard.wd1",
    // No wd number: the host cannot be built.
    "mastercard/CorporateCareers",
    // wd0 does not exist; a leading-zero number is never written by Workday.
    "mastercard.wd0/CorporateCareers",
    // Empty site.
    "mastercard.wd1/",
    // A slash inside the site would add path structure to the request.
    "mastercard.wd1/Corporate/Careers",
    // A pasted URL, not a token: a lenient split would mine host parts out of it.
    "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers",
    // Leading space: refused, not silently trimmed.
    " mastercard.wd1/CorporateCareers",
    // Uppercase tenant: Workday hosts are lowercase, so this is a typo.
    "Mastercard.wd1/CorporateCareers",
    // A space inside the tenant.
    "master card.wd1/CorporateCareers",
    // A fragment would collide with the page cursor this adapter writes.
    "mastercard.wd1/CorporateCareers#x",
    // A facet parameter with no ids.
    "mastercard.wd1/CorporateCareers?locations=",
    // Ids that are not 32 lowercase hex characters.
    "mastercard.wd1/CorporateCareers?locations=xyz",
    // A 31-character id: one character lost in a copy.
    `mastercard.wd1/CorporateCareers?locations=${ID_A.slice(1)}`,
    // A trailing comma: an empty id.
    `mastercard.wd1/CorporateCareers?locations=${ID_A},`,
    // A second parameter: only one facet is supported.
    `mastercard.wd1/CorporateCareers?locations=${ID_A}&x=1`,
    // A facet with no parameter name.
    `mastercard.wd1/CorporateCareers?=${ID_A}`,
    // Host-shaped junk before the tenant, which a suffix match would accept.
    "evil.com/x.wd1/CorporateCareers",
  ];
  // Every one must be refused outright.
  for (const token of bad) assert.equal(parseWorkdayToken(token), null, `accepted ${JSON.stringify(token)}`);
});

// --- requests: the first-page URL and the POST body -------------------------------------

test("workday builds the cxs jobs endpoint with an explicit first-page cursor", () => {
  // Page one carries `#offset=0`, so no URL without a cursor is ever a valid page.
  assert.equal(workdayAdapter.buildRequestUrl(TOKEN), `${ENDPOINT}#offset=0`);
});

test("workday refuses to build a request from a malformed token", () => {
  // A throw lands in both scouts' catch, which records a failed board.
  assert.throws(() => workdayAdapter.buildRequestUrl("mastercard"), /malformed workday board token/);
});

test("workday page one posts the careers-page body at offset 0", () => {
  // The body a real careers page sends, byte for byte in key order.
  assert.equal(
    workdayAdapter.requestBody!(TOKEN, `${ENDPOINT}#offset=0`),
    JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
  );
});

test("workday request body carries the token's facet ids at the cursor's offset", () => {
  // A later page of a faceted board.
  const token = `${TOKEN}?locations=${ID_A},${ID_B}`;
  // The facet narrows the board to the listed locations; the offset comes from the cursor.
  assert.equal(
    workdayAdapter.requestBody!(token, `${ENDPOINT}#offset=40&total=226`),
    JSON.stringify({ appliedFacets: { locations: [ID_A, ID_B] }, limit: 20, offset: 40, searchText: "" }),
  );
});

// THE RED-ON-REVERT TEST FOR THE CURSOR PARSE (condition 2): a lenient parse that
// fell back to offset 0 would re-read page one and call the board complete.
test("workday request body refuses a missing or garbage cursor", () => {
  // Every one of these must answer null, never a body at offset 0.
  const bad = [
    // No cursor at all: the lenient fallback this test exists to catch.
    ENDPOINT,
    // An empty cursor.
    `${ENDPOINT}#`,
    // A non-numeric offset.
    `${ENDPOINT}#offset=abc`,
    // A negative offset.
    `${ENDPOINT}#offset=-20&total=40`,
    // A later page that lost page one's total.
    `${ENDPOINT}#offset=20`,
    // Page one never carries a total; this shape is never written.
    `${ENDPOINT}#offset=0&total=40`,
    // Not a whole page: Workday windows are multiples of 20.
    `${ENDPOINT}#offset=25&total=100`,
    // An offset at the total: past the last page.
    `${ENDPOINT}#offset=40&total=40`,
    // A leading zero, which this adapter never writes.
    `${ENDPOINT}#offset=020&total=100`,
    // A total at Workday's cap, which parse already refuses.
    `${ENDPOINT}#offset=20&total=2000`,
    // An extra key riding along.
    `${ENDPOINT}#offset=20&total=45&x=1`,
    // A valid cursor on ANOTHER board's endpoint.
    "https://other.wd1.myworkdayjobs.com/wday/cxs/other/CorporateCareers/jobs#offset=0",
  ];
  // Checked one by one so the failure names the URL that slipped through.
  for (const url of bad) assert.equal(workdayAdapter.requestBody!(TOKEN, url), null, `accepted ${url}`);
  // A malformed token is refused too, even with a valid cursor.
  assert.equal(workdayAdapter.requestBody!("mastercard", `${ENDPOINT}#offset=0`), null);
});

// --- the cursor: page one's total, carried forward --------------------------------------

test("workday next page reads total from page one and carries it in the cursor", () => {
  // 45 postings: pages at 0, 20, 40.
  assert.equal(workdayAdapter.nextPageUrl!(TOKEN, wdPage(45, fullPage("a")), `${ENDPOINT}#offset=0`), `${ENDPOINT}#offset=20&total=45`);
});

test("workday later pages ignore their own total of 0 and use the cursor's", () => {
  // Page two says total 0, as the live API does; the cursor's 45 wins.
  assert.equal(workdayAdapter.nextPageUrl!(TOKEN, wdPage(0, fullPage("b")), `${ENDPOINT}#offset=20&total=45`), `${ENDPOINT}#offset=40&total=45`);
  // Page three is the last: 40 + 20 reaches 45.
  assert.equal(workdayAdapter.nextPageUrl!(TOKEN, wdPage(0, ["c0"]), `${ENDPOINT}#offset=40&total=45`), null);
});

test("workday stops after page one when the board fits in it", () => {
  // Seven postings, exactly twenty, and an empty board: one page each.
  for (const total of [7, 20, 0]) {
    // Page one is the last page.
    assert.equal(workdayAdapter.nextPageUrl!(TOKEN, wdPage(total, []), `${ENDPOINT}#offset=0`), null, `total ${total}`);
  }
});

test("workday next page stalls on an unreadable cursor or total instead of guessing", () => {
  // A garbage cursor: answering with the same URL makes the loop fail the board
  // ("cursor did not advance"); null would store what was read as the whole board.
  const garbage = `${ENDPOINT}#offset=abc`;
  // Stalls on the garbage cursor.
  assert.equal(workdayAdapter.nextPageUrl!(TOKEN, wdPage(45, []), garbage), garbage);
  // Page one whose total is not a whole number: no way to know where the board ends.
  for (const total of ["45", 45.5, -1, null]) {
    // A wrong-typed total stalls too.
    const page = { total, jobPostings: [] };
    // Same URL back, so the loop refuses the board.
    assert.equal(workdayAdapter.nextPageUrl!(TOKEN, page, `${ENDPOINT}#offset=0`), `${ENDPOINT}#offset=0`, `total ${String(total)}`);
  }
});

// --- parse: postings, absolute apply links, refusals ------------------------------------

test("workday parses a list page into postings with absolute apply links", () => {
  // One posting, read with the board token so its relative path can be resolved.
  const result = workdayAdapter.parse(wdPage(1, ["123"]), TOKEN);
  // Parsed cleanly.
  assert.equal(result.ok, true);
  // Narrowed for the field checks.
  if (!result.ok) return;
  // Exactly one posting, nothing skipped.
  assert.equal(result.postings.length, 1);
  // A clean entry produces no skip record.
  assert.deepEqual(result.skipped, []);
  // The posting's fields.
  const [posting] = result.postings;
  // externalPath is the stable per-board id.
  assert.equal(posting!.atsJobId, "/job/Pune-India/Senior-Software-Engineer_R-123");
  // The title as posted.
  assert.equal(posting!.title, "Senior Software Engineer 123");
  // Workday's location prose, verbatim.
  assert.equal(posting!.locationRaw, "Pune, India");
  // The public posting page: origin + site + externalPath.
  assert.equal(posting!.applyUrl, "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Pune-India/Senior-Software-Engineer_R-123");
  // The list endpoint has no description; absence is declared, not invented.
  assert.equal(posting!.descriptionRaw, null);
  // Relative date prose goes to the shared relative-date reader.
  assert.deepEqual(posting!.postedAtInput, { source: "aggregator", relativeText: "Posted 3 Days Ago" });
});

test("workday parse without the board token fails instead of building a relative link", () => {
  // A caller that forgets the token gets a failed board, never an unusable apply_url.
  const result = workdayAdapter.parse(wdPage(1, ["123"]));
  // Refused.
  assert.equal(result.ok, false);
});

test("workday refuses a board at Workday's 2000-posting cap", () => {
  // total 2000 means "2000 or more": the board cannot be read in full.
  const result = workdayAdapter.parse(wdPage(2000, fullPage("a")), TOKEN);
  // Refused, with a reason naming the fix.
  assert.equal(result.ok, false);
  // The reason points at the facet.
  if (!result.ok) assert.match(result.reason, /2000/);
});

test("workday parse rejects a payload without a jobPostings array", () => {
  // An error page, a bare array, null, and an object without the list.
  for (const payload of [{}, [], null, "x", { total: 3, jobPostings: {} }]) {
    // Every one is a failed board, never an empty one.
    assert.equal(workdayAdapter.parse(payload, TOKEN).ok, false, JSON.stringify(payload));
  }
});

test("workday skips a posting whose externalPath is not a plain /job/ path", () => {
  // Paths that would leave the board's origin or climb out of the site.
  const page = {
    // Page one's total, so the envelope is otherwise valid.
    total: 4,
    // Four entries, each wrong in a different way.
    jobPostings: [
      // An absolute URL to another host instead of a path.
      { title: "A", externalPath: "https://evil.example/job/x" },
      // A protocol-relative path, which resolves to another host.
      { title: "B", externalPath: "//evil.example/job/x" },
      // Dot segments that climb out of the site after URL resolution.
      { title: "C", externalPath: "/job/../../evil" },
      // No path at all: nothing to link to.
      { title: "D" },
    ],
  };
  // The page parses, but none of these becomes a posting.
  const result = workdayAdapter.parse(page, TOKEN);
  // Parsed as a page.
  assert.equal(result.ok, true);
  // Nothing stored; each skip recorded.
  if (result.ok) {
    // Zero postings.
    assert.equal(result.postings.length, 0);
    // Four skips, one per entry.
    assert.equal(result.skipped.length, 4);
  }
});

test("workday reports no identity, declared rather than guessed", () => {
  // The list payload names no company; null means "check inapplicable".
  assert.equal(workdayAdapter.readReportedIdentity(wdPage(1, ["1"])), null);
});

// --- the shared page loop, driven by the real Workday adapter ---------------------------

test("the page loop posts each page's body and reads every Workday page", async () => {
  // Every (url, body) pair the loop asked for, in order.
  const asked: Array<[string, string | undefined]> = [];
  // Pages keyed by offset; page two and three say total 0, as live.
  const pages = new Map<number, unknown>([[0, wdPage(45, fullPage("a"))], [20, wdPage(0, fullPage("b"))], [40, wdPage(0, ["c0", "c1", "c2", "c3", "c4"])]]);
  // A fake transport that serves the page the BODY names, as Workday does.
  const fetchJson = async (url: string, body?: string): Promise<unknown> => {
    // Recorded before anything else, so a throw still leaves a trace.
    asked.push([url, body]);
    // The offset is in the body, never the URL.
    const offset = (JSON.parse(body ?? "null") as { offset: number } | null)?.offset;
    // An unknown page throws, as an HttpError would.
    if (offset === undefined || !pages.has(offset)) throw new Error(`no page for body ${String(body)}`);
    // The page itself.
    return pages.get(offset);
  };
  // The whole board through the real loop.
  const result = await collectBoardPages(workdayAdapter, TOKEN, fetchJson);
  // All 45 postings arrived.
  assert.equal(result.ok, true);
  // Count checked on the success arm.
  if (result.ok) assert.equal(result.postings.length, 45);
  // Three requests, each a body at the right offset, each URL carrying its cursor.
  assert.deepEqual(asked.map(([url, body]) => [url, JSON.parse(body!).offset]), [
    // Page one: the explicit first cursor, body offset 0.
    [`${ENDPOINT}#offset=0`, 0],
    // Page two: page one's total carried forward in the cursor.
    [`${ENDPOINT}#offset=20&total=45`, 20],
    // Page three, the last.
    [`${ENDPOINT}#offset=40&total=45`, 40],
  ]);
});

test("the page loop fails a board whose request body cannot be built", async () => {
  // An adapter whose body builder refuses: the loop must not fetch anything.
  const refusing: AtsAdapter = { ...workdayAdapter, requestBody: () => null };
  // Counts fetches; there must be none.
  let fetches = 0;
  // The loop over the refusing adapter.
  const result = await collectBoardPages(refusing, TOKEN, async () => { fetches += 1; return wdPage(1, ["1"]); });
  // Failed, and nothing was sent.
  assert.equal(result.ok, false);
  // Refused before contact: no request went out.
  assert.equal(fetches, 0);
});

test("a Workday board over 400 postings fails at the page cap instead of truncating", async () => {
  // 401 postings need 21 pages of 20; the cap is 20.
  const fetchJson = async (_url: string, body?: string): Promise<unknown> => {
    // Page one carries the total; the rest say 0.
    const offset = (JSON.parse(body!) as { offset: number }).offset;
    // Always a full page, so only the cursor decides when to stop.
    return wdPage(offset === 0 ? 401 : 0, fullPage(`p${offset}-`));
  };
  // Read through the real loop with the real cap.
  const result = await collectBoardPages(workdayAdapter, TOKEN, fetchJson);
  // Refused rather than stored as 400 of 401.
  assert.equal(result.ok, false);
  // The reason names the cap.
  if (!result.ok) assert.match(result.reason, new RegExp(`page cap of ${MAX_BOARD_PAGES}`));
});

test("the page loop sends no body for a GET board", async () => {
  // Every body the loop handed the transport.
  const bodies: Array<string | undefined> = [];
  // A one-page GET adapter: no requestBody method.
  const getAdapter: AtsAdapter = {
    // Any GET provider will do; greenhouse is the original one.
    provider: "greenhouse",
    // Where it was found, required by the contract.
    discoverySource: "greenhouse",
    // A one-page board URL.
    buildRequestUrl: (t) => `https://fake.test/${t}`,
    // An empty, valid page.
    parse: () => ({ ok: true, postings: [], skipped: [] }),
    // No identity signal, declared.
    readReportedIdentity: () => null,
  };
  // The loop over it.
  await collectBoardPages(getAdapter, "acme", async (_url, body) => { bodies.push(body); return {}; });
  // Exactly one request, with no body: the GET path is unchanged.
  assert.deepEqual(bodies, [undefined]);
});
