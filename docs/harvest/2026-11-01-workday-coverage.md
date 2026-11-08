# Workday coverage — 2026-11-01

> **Status 2026-11-08:** Partly superseded. The adapter shipped (1294acc) and is registered in `supabase/functions/_shared/ats/registry.ts`. Two limits listed below are closed: new title-passing Workday jobs now get a description from `_shared/scout/workday-detail.ts` (54ee8be), and the apply guard exists (`worker/src/workday.ts` parks Workday rows for Manual apply). The quirks table and re-check recipe still hold. Current truth: [README.md](README.md). The body below is the original record, unedited.

**Result:** 18 Workday boards verified and read in full, live, through the real adapter
(`supabase/functions/_shared/scout/adapters/workday.ts`). Seed:
`supabase/snippets/2026-11-01-seed-watchlist-workday.sql` (written, not run). Accenture
is verified but unreadable (see below).

## Why

On 2026-11-01 the orchestrator probed 99 India-hiring companies against the five
supported providers (730 GETs). 10 were seeded (ccbe3da); 89 matched nothing. Separately,
25 live greenhouse watchlist rows were disabled as dead. This pass asked: how many of
those ~114 companies are on Workday, and is that enough (≥10) to justify an adapter?

## Method

1. **Discovery** (2 read-only recon agents, 54 + 60 companies): each company's own careers
   page, fetched or rendered headless, grepped for `myworkdayjobs.com` / `wday/cxs`.
   Search hits were leads only. Name-guessed tenants were banned as evidence.
   Result: 19 named. 17 came from the company's own page; PayPal and Salesforce came
   from search leads, and the live check below confirmed both.
2. **Verification** (one POST + one detail GET each, 1.1 s apart): PASS = HTTP 200 +
   `{total, jobPostings[]}` + total > 0 + identity. Identity is the posting detail's own
   `hiringOrganization.name`, or its titles and locations where that field is empty.
   **19/19 PASS.** Control `zz-no-such-tenant-xx.wd5` FAILED (HTTP 422).
3. **Robots**: the repo's own `checkRobots` (packages/master-robots) answered `allow` for
   `/wday/cxs/…` on all 19 tenants. Non-vacuous: on nvidia.wd5 it refused a path that
   robots.txt disallows, and it refused the garbage tenant (robots HTTP 422).
4. **Full read**: each seed token was built from page one's live facets and passed
   `parseWorkdayToken`. Each board was then read through `collectBoardPages` with the
   real adapter. **18/18 read in full**, and every read stored exactly its reported total.

## Workday quirks the adapter is built around

All of these were proved live on nvidia.wd5, a non-candidate tenant.

| quirk | consequence |
|---|---|
| The list endpoint is POST-only (GET → 400). | Optional `requestBody` in the adapter contract. Both scouts POST when it is present. |
| `total` is sent on page one only; later pages say `total: 0`. | Page one's total travels in the page URL's fragment (`#offset=40&total=238`). fetch never sends the fragment. |
| A page holds 20 postings at most (`limit: 50` → 400). | 20 pages × 20 = **400 postings per board**. A larger board fails at the cap; it is never truncated. |
| `total` caps at 2000, and `offset=2000` wraps back to page one. | `parse` refuses a board that reports 2000. |

## Verified boards

The read total is what one full read stored. For faceted boards it is the India-only
total. Facet ids are tenant-specific; the full tokens are in the seed snippet.

| company | token (base; facet ids in the seed) | unfiltered total | read total (India when faceted) | facet | identity (hiringOrganization) |
|---|---|---|---|---|---|
| Fractal Analytics | `fractal.wd1/Careers` | 117 | 117 | none | Fractal Analytics Ltd. |
| Quantiphi | `quantiphi.wd1/Careers_at_Quantiphi` | 76 | 76 | none | Quantiphi Analytics Solutions Private Limited |
| PayPal | `paypal.wd1/jobs` | 324 | 324 | none | 0020 PayPal, Inc. |
| Sprinklr | `sprinklr.wd1/careers` | 72 | 72 | none | Sprinklr Inc. |
| ServiceTitan | `servicetitan.wd1/ServiceTitan` | 76 | 76 | none | LE0001 ServiceTitan, Inc. |
| Zendesk | `zendesk.wd1/zendesk` | 146 | 146 | none | Base Poland (Poland) |
| Visa | `visa.wd5/Visa` | 836 | 95 | country `locationCountry` | (empty; titles/locations match) |
| Cadence Design Systems | `cadence.wd1/External_Careers` | 676 | 196 | country `Location_Country` | (empty; titles/locations match) |
| Boeing | `boeing.wd1/EXTERNAL_CAREERS` | 670 | 2 | country `locationCountry` | (empty; titles/locations match) |
| Fidelity Investments | `fmr.wd1/FidelityCareers` | 804 | 12 | country `locationCountry` | Fidelity Brokerage Services LLC |
| Target | `target.wd5/targetcareers` | 2000 | 63 | country `Location_Country` | 1001 Target Corporation |
| Wells Fargo | `wf.wd1/WellsFargoJobs` | 1497 | 81 | country `locationCountry` | D13 Wells Fargo Clearing Services, LLC |
| Salesforce | `salesforce.wd12/External_Career_Site` | 1551 | 91 | country `CF_-_REC_-_LRV_-_Job_Posting_Anchor_-_Country_from_Job_Posting_Location_Extended` | 120 SFDC Mexico S. de R.L. de C.V. |
| Cisco | `cisco.wd5/Cisco_Careers` | 1442 | 314 | city ids `locations` (8) | 020 Cisco Systems, Inc. |
| Mastercard | `mastercard.wd1/CorporateCareers` | 1014 | 223 | city ids `locations` (9) | US: Mastercard International Incor |
| Barclays | `barclays.wd3/External_Career_Site_Barclays` | 622 | 298 | city ids `locations` (11) | 1203 Barclays Global Serv. Cent |
| Nike | `nike.wd1/nke` | 749 | 59 | city ids `locations` (3) | NIKE, Inc. |
| HPE | `hpe.wd5/Jobsathpe` | 1743 | 377 | city ids `locations` (44) | (empty; titles/locations match) |

- **Accenture** (`accenture.wd103/AccentureCareers`) verified (`1000 Accenture LLP
  Company`), but it reports 2000 (the cap), and its India facet alone lists 34,628.
  No token can read it in full, so it is left out.
- ServiceTitan's SmartRecruiters account was rejected as dead in the morning probe.
  Workday is its live board (9 India postings, Bengaluru).
- Boeing (2 India postings) and Fidelity (12) are thin, but valid.

## Known limits

- **City-id facets are a snapshot.** Cisco, Mastercard, Barclays, Nike and HPE have no
  country facet, so their tokens list today's India location ids. A new India office is
  not covered until the token is re-derived.
- **HPE is close to the cap**: 377 of 400. Watch it on the health page.
- **"N Locations"**: Workday's list prose collapses multi-location postings, so the
  screener sees "3 Locations" rather than the cities. On faceted boards, every posting
  has at least one India location by construction.
- **No description**: the list endpoint has none. A detail read per posting would
  multiply requests by the board size, so `descriptionRaw` is null.
- **Identity**: the list payload names no company, so `readReportedIdentity` returns
  null ("check inapplicable"). Identity was verified once here, per board.
- **Apply**: discovery only. A guard that parks Workday rows for a human is parcel 2;
  the seed waits for it.

## Not on Workday (side findings from the sweep)

- **Darwinbox** hosts 10 of the India startups: Pine Labs, Rapido, Go Digit, Spinny,
  PhysicsWallah, upGrad, Porter, Locus, Delhivery, LeadSquared. It is the next adapter
  by coverage for this list.
- Oracle Recruiting Cloud: Dell (redirects there), Icertis, JPMorgan Chase.
  SuccessFactors: Wipro.
- Single-company ATSs: Rippling, RippleHire, Kula, JazzHR, MyNextHire, Recruitee,
  Zwayam, Param.ai, PyjamaHR, TurboHire, Keka.
- Arcesium is on greenhouse `arcesiumllc`; the orchestrator re-probed and seeded it.
  The Myntra and Innovaccer greenhouse leads did not reproduce (404).

## Re-checking

Repeat step 2 for any board: POST
`https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with
`{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}`. Expect 200, a numeric
`total`, and a `jobPostings` array. Garbage tenants answer 422.
