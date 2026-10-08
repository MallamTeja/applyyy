> **Historical record as of 2026-09-17.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Company watchlist — board token verification, 65 companies

**Date:** 2026-09-17
**Account:** `tejamallam00@gmail.com`
**Method:** live HTTP probes of candidate ATS board endpoints (detail in §3)
**Result:** **23 of 65 pollable. 42 unreachable.**
**Artifact:** `supabase/snippets/2026-09-17-seed-watchlist-verified.sql` — run by hand
in the Supabase SQL editor; idempotent; aborts loudly if the account is not found.

---

## 1. The finding that matters — provider coverage is the binding constraint, not company coverage

Teja asked for 65 companies. 23 can be polled. The other 42 are not missing because
nobody found their careers page — most of them were located. They are unreachable
because **this build has three ATS adapters and those companies use something else.**

`_shared/ats/registry.ts:38-45` maps exactly three providers to adapters:
`greenhouse`, `lever`, `ashby`. The `ats_provider` enum
(`20260909234500_enums.sql:127-136`) also contains `workable`, `smartrecruiters`,
`unknown` and `other` — a row naming one of those is accepted by the schema, stored,
and then **silently skipped by the Scout**, because `getAdapter()` returns `null` for
it by design. It looks configured. It polls nothing.

**And the misses cluster.** Of the 42, these are Indian or India-heavy employers:
Swiggy, Zepto, Zomato, Blinkit, Dunzo, LTIMindtree, PhonePe, Flipkart, EPAM Systems,
Publicis Sapient — plus Atlassian, Postman, BrowserStack, Chargebee and Juspay, whose
portals could not be identified at all. Greenhouse, Lever and Ashby are US-startup-shaped
hiring infrastructure. **The Indian market runs on Darwinbox, Workday and in-house
portals**, and none of those are reachable from here.

So, stated plainly: **for an India-based job search, this is an adapter-writing problem,
not a company-list problem.** Adding another 65 company names to the watchlist would not
move the number materially; the next adapter would. The highest-value single adapter is
identified in §5.

---

## 2. What was seeded — the 23 verified boards

Every row below was confirmed by a probe that (a) returned HTTP 200, (b) parsed as
well-shaped JSON of the provider's documented response shape, and (c) contained **at
least one real posting**. Job counts are as observed on 2026-09-17 and will drift; they
are recorded as *evidence the board was live*, not as a property of the board.

| # | Company | Provider | `board_token` | Postings |
|---|---|---|---|---|
| 1 | Razorpay | greenhouse | `razorpaysoftwareprivatelimited` | 19 |
| 2 | Groww | greenhouse | `groww` | 8 |
| 3 | CRED | lever | `cred` | 11 |
| 4 | Snowflake | ashby | `snowflake` | 346 |
| 5 | Databricks | greenhouse | `databricks` | 879 |
| 6 | Confluent | ashby | `confluent` | 21 |
| 7 | Twilio | greenhouse | `twilio` | 148 |
| 8 | Okta | greenhouse | `okta` | 322 |
| 9 | Elastic | greenhouse | `elastic` | 360 |
| 10 | Palantir | lever | `palantir` | 313 |
| 11 | Figma | greenhouse | `figma` | 153 |
| 12 | Brex | greenhouse | `brex` | 261 |
| 13 | Plaid | ashby | `plaid` | 110 |
| 14 | Stripe | greenhouse | `stripe` | 654 |
| 15 | Coinbase | greenhouse | `coinbase` | 220 |
| 16 | **Microsoft AI** | greenhouse | `microsoftcorporation` | 40 |
| 17 | Airbnb | greenhouse | `airbnb` | 163 |
| 18 | Paytm | lever | `paytm` | 204 |
| 19 | Meesho | lever | `meesho` | 49 |
| 20 | UiPath | ashby | `uipath` | 107 |
| 21 | Dropbox | greenhouse | `dropbox` | 41 |
| 22 | Checkout.com | ashby | `checkout.com` | 160 |
| 23 | Thoughtworks | greenhouse | `thoughtworks` | 40 |

**Split:** greenhouse 14, lever 4, ashby 5. Total observed postings **4,629** — a first-poll
volume worth knowing about before enabling all 23 at once, since Databricks (879) and
Stripe (654) alone are 33% of it.

### 2.1 Per-row notes that cannot be re-derived

These are the four rows where the obvious reading of the table is wrong. Each is also
recorded as a comment on its own row in the SQL file, because a note only in a doc is a
note the next person will not have open.

**Row 16 is `Microsoft AI`, not `Microsoft`.** The token `microsoftcorporation` is a real
Greenhouse board, but every posting it returns carries `company_name: "Microsoft AI"`. It
is the MAI org's board. Microsoft's corporate requisitions live on the in-house
`careers.microsoft.com` portal and are **not** reachable by any adapter in this build.
Naming the row "Microsoft" would claim coverage we do not have, and afterwards nothing in
the system would reveal the gap — the row would look right.

**Row 1's token is a registered legal entity name.** `razorpaysoftwareprivatelimited` was
found only by scraping `razorpay.com/jobs`. No name-derived guess produces it. This is the
general warning for the whole exercise: **a board token is not a function of the company
name**, and any future tooling that generates candidate tokens from names will find a
minority of boards and silently miss the rest.

**Row 22's token contains a literal dot: `checkout.com`.** Verified safe end to end — the
Ashby adapter wraps the token in `encodeURIComponent` (`_shared/ats/ashby.ts:60`, origin at
`:36`), and `.` is an unreserved character in RFC 3986, so it passes through unchanged into
the request URL. **Consequence for future work:** any `board_token` validation regex written
as `[a-z0-9-]+` would reject a token that has been proven to work. Widen the pattern; do not
drop the row.

**Row 23 uses Thoughtworks' Greenhouse board because its Ashby board is a trap.**
Thoughtworks also has an Ashby board. That board returns **HTTP 200 with a well-formed
`{"jobs":[]}` body** — a real, empty board, not a bad token. A probe checking only the
status code would have recorded it as valid, and that company would have polled zero jobs
forever while appearing correctly configured. This is why the verification rule in §3 exists.

**Row 2 (Groww) has a two-host subtlety.** Groww's public board is served from Greenhouse's
EU cluster, `job-boards.eu.greenhouse.io`. The canonical `boards-api.greenhouse.io` endpoint
that the adapter actually calls answers correctly for this token — verified directly, not
assumed. Do not "fix" the row toward the EU host; the adapter has one origin.

---

## 3. Probe method, and the verification rule

### Endpoints probed

| Provider | Endpoint |
|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/<token>/jobs` |
| Lever | `https://api.lever.co/v0/postings/<token>?mode=json` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/<token>` |
| SmartRecruiters (survey only) | `https://api.smartrecruiters.com/v1/companies/<token>/postings` |
| Workday (survey only) | the employer's own `*.myworkdayjobs.com` tenant URL |

Candidate tokens came from three sources, in order of reliability: the company's own
careers page link target; the board URL embedded in a job posting; and — last, and only as
a hypothesis to be tested — a slug guessed from the company name.

### The verification rule

> **A 200 is not enough. The body must parse into the provider's documented shape AND
> carry at least one posting.**

All three conditions were required for a row to be called *verified*. This is not
pedantry; three separate failure modes in this exercise would have passed a status-code
check:

1. **Thoughtworks' Ashby board** — 200, valid JSON, zero postings. A real board nobody
   uses. Recorded as a trap in §2.1, not as a bad token.
2. **A fabricated Workday tenant** — see §4.2. Returns the same HTTP 500 as a real one.
3. **Soft-200 error pages** generally — an HTML "not found" page served with status 200
   parses to zero jobs, which a permissive reader reports as "board exists, no openings".

This is `CLAUDE.md` §5 exactly: *the permissiveness of the reader is the fail-open.* Asking
an endpoint "did you fail?" inherits the endpoint's eagerness to succeed. Asking "is this
the shape I expect, with content in it?" does not.

---

## 4. The 42 that are not pollable

Grouped by *why*, because the reason determines whether it is fixable and by what.

### 4.1 On a provider we have no adapter for — **fixable by writing an adapter**

| Company | Portal | Status |
|---|---|---|
| ServiceNow | SmartRecruiters | **API-confirmed**, 642 live postings — see §5 |
| NVIDIA | Workday | **Confirmed** (HTTP 200 on their tenant) |
| Intel | Workday | **Confirmed** (HTTP 200) |
| Adobe | Workday | **Confirmed** (HTTP 200) |
| VMware / Broadcom | Workday | **Confirmed** (HTTP 200) |
| Workday | Workday | **Confirmed** (HTTP 200) |
| BrowserStack | Workday | **Believed, not confirmed** — careers HTML references `myworkdayjobs.com`; no 200 obtained |
| CrowdStrike | Workday | **Believed, not confirmed** — same evidence, same limit |

Read the last two rows carefully. *Confirmed* here means a request returned 200 from the
tenant. *Believed* means the company's careers page links at Workday and nothing stronger
was established. Those are different claims and the table keeps them different on purpose.

### 4.2 The Workday false-positive we nearly shipped

A probing agent was about to report Workday tenants **confirmed** for AMD, Qualcomm and
Nutanix on the strength of an HTTP **500** from the candidate URL — reasoning that a server
error means a server is there. It then control-tested a **deliberately fabricated tenant
name**, which returned **HTTP 500 as well**.

The 500 carried no information about whether the tenant existed. Only a 200 does.

This is worth recording beyond the three companies it saved, because it is the repo's core
bug pattern arriving in a new costume: a lenient endpoint asked *"did you fail?"* instead of
being asked to *produce the shape of success*. The control test — probe something you know
is fake and check the answer differs — is the cheap, general defence, and it is the same
move as "revert your fix and confirm the test goes red."

### 4.3 In-house or proprietary portal — **not fixable by an ATS adapter at all**

Google, Amazon, Apple, Uber, Microsoft (corporate, as distinct from the MAI board in row
16), Salesforce, ServiceNow's own site, Flipkart, PhonePe, Walmart Global Tech, Target,
JPMorgan Chase, Goldman Sachs, Morgan Stanley, American Express, HSBC, BlackRock, Swiggy,
Zomato, Blinkit, Zepto, Canva, LTIMindtree, Publicis Sapient, EPAM Systems.

These run their own careers stacks (or, for several of the Indian employers, Darwinbox).
Reaching them means a scraper per employer, with its own robots.txt posture and its own
maintenance burden — a different kind of work from an ATS adapter, and it should be costed
as such rather than folded into "add more companies".

### 4.4 Wound down — do not spend a row

**Dunzo.** `dunzo.com` fails to connect, and `nslookup` resolves it to `127.0.0.1`, which is
a parked/null record rather than a host. The company has wound down. A watchlist row for it
would be a permanently failing poll.

### 4.5 Portal genuinely unidentified — **say so; do not guess**

AMD, Qualcomm, Nutanix, Intuit, SAP, Salesforce, Atlassian, Postman, Chargebee, Juspay,
Turnitin.

For these, bounded probing did not establish which portal they use. The column is left
empty rather than filled with a plausible guess, because a guessed provider in a doc is
indistinguishable from a measured one three weeks later — and this doc's only value is that
the distinction holds.

### 4.6 Full list of the 42

Atlassian, Postman, BrowserStack, Chargebee, Juspay, CrowdStrike, Salesforce, ServiceNow,
SAP, Workday, Adobe, Intuit, Nutanix, VMware, NVIDIA, AMD, Qualcomm, Intel, Google, Amazon,
Apple, Uber, PhonePe, Flipkart, Walmart Global Tech, Target, JPMorgan Chase, Goldman Sachs,
Morgan Stanley, American Express, HSBC, BlackRock, Turnitin, Canva, Dunzo, Zepto, Swiggy,
Zomato, Blinkit, LTIMindtree, Publicis Sapient, EPAM Systems.

---

## 5. The single highest-value next move: a SmartRecruiters adapter

**ServiceNow is on SmartRecruiters with 642 live postings, API-confirmed** —
`https://api.smartrecruiters.com/v1/companies/ServiceNow/postings` returned
`totalFound: 642`. That is not an inference from a careers page; the API answered.

Three things make this the cheapest large win available:

1. **The enum already has the value.** `smartrecruiters` is in `public.ats_provider`
   (`20260909234500_enums.sql:132`). No migration, no `alter type ... add value` — which
   matters, because that statement is a documented trap in this repo
   (`20260910185900:5-19`).
2. **The registry says the cost out loud.** `registry.ts:33-36`: *"PHASE 2 IS ONE LINE
   HERE. Adding Workable or SmartRecruiters means writing one file that satisfies
   `AtsAdapter` and adding one entry below — the Scout does not change, `toJobInsert` does
   not change, and no existing adapter is touched."*
3. **One company alone justifies it**, and SmartRecruiters is not a one-company provider.

**What was deliberately NOT done:** no `smartrecruiters` row was emitted into the seed SQL.
A row for a provider with no adapter is accepted by the schema, stored, and skipped —
producing a watchlist that *reads as configured while polling nothing*. That is the failure
this whole document is about, and it would be perverse to commit an instance of it in the
same change that documents it. **The row lands when the adapter lands, in the same commit.**

By contrast, a Workday adapter would unlock more companies (five confirmed in §4.1) but is
a much larger job — Workday tenants are per-employer, the response shape is not a stable
public posting API, and two of the seven candidates are unconfirmed. Recommend
SmartRecruiters first on effort-to-coverage, and treat Workday as its own scoped piece of
work rather than "the next one down the list".

---

## 6. What this exercise did NOT establish — the limits

State these before quoting any number above.

- **"Not pollable" means "not found under plausible slugs", not "has no board."** Probing
  was bounded. A company can have a Greenhouse board under an unrelated slug — an acquired
  brand, a legal entity, a regional subsidiary. **Razorpay is the existence proof inside our
  own verified set**: `razorpaysoftwareprivatelimited` would have been missed by every
  plausible guess, and was recovered only by scraping the company's own careers page. Assume
  some of the 42 have boards we did not find.
- **Job counts are a measurement at a timestamp**, not a property of the board. They record
  that the board was live on 2026-09-17. Do not treat a later different count as a defect.
- **Nothing here was verified against the live database.** No session in this repo can
  authenticate as Teja — the `supabase` MCP server is configured but unauthenticated — so
  "are these rows now in `company_watchlist`?" is unanswerable from inside a session. It is
  answered by running the SQL file and reading its verification `SELECT`.
- **The seed SQL has not been executed.** It is written, reviewed and idempotent. It has
  **never been run against any database**, so it is *unexercised*: no claim is made here
  that it executes cleanly, only that it was written to. The first run is the test.
- **`enabled = true` on all 23 is a choice, not a finding.** Every board was live, so none
  was seeded off. If the first poll's volume (§2, 4,629 postings) is unwelcome, disabling
  the largest boards is a one-column update and does not invalidate anything in this doc.

---

## 7. Files

| Path | What it is |
|---|---|
| `supabase/snippets/2026-09-17-seed-watchlist-verified.sql` | The seed. Run by hand in the Supabase SQL editor. Idempotent; aborts with an exception if the account is not found. |
| `docs/watchlist/2026-09-17-board-token-verification.md` | This document — the evidence behind every token in that file. |

`docs/watchlist/` is a new namespace created by this change, per the repo convention that
`docs/` is namespaced by topic with one owner each and flat files in `docs/` collide
between writers.
