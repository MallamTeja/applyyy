# Job discovery channels — inventory + findings register (2026-11-18 22:10 IST)

Two read-only recon agents (code inventory; live health over 14 days), spot-checked by the orchestrator.
Orch re-measured: Workday collapse (watchlist 63/64 enabled failing; new Workday jobs/day 11-13 287 → 11-17 0),
`remote-feeds.ts:295` `includes('intern')`, `remote-feeds.ts:256` excerpt-first, adzuna/jooble 0 imports.
Everything else is the agents' evidence, not yet re-measured. Re-measure before building on it.

## Channels

| # | Channel | Trigger | Source | Lands at | 14 d rows / passed |
|---|---|---|---|---|---|
| 1 | ATS watchlist scout (worker) `scout.yml` → `worker/src/cli/scout.ts` | cron 10×/day + dispatch | `company_watchlist`: greenhouse 112, ashby 78, workday 64, lever 28 enabled | passed_filters / dropped_filter (discovered if held or screener fails) | GH 2903/9, Ashby 1638/2, Lever 202/2, Workday 3478/23 |
| 2 | ATS watchlist scout (edge) `scout-ats` | "Scout Watchlist" button | same watchlist | same | shared with #1 |
| 3 | Remote feeds `scout-remote.yml` | cron daily 07:00 IST | RemoteOK, Jobicy, Arbeitnow | same; ATS twins → dropped_duplicate | 770/9 |
| 4 | Web scout `scout-web` | button | Gemini + Google search, GH/Lever/Ashby URLs only | always `discovered`, unscreened | ~0 visible |
| 5 | Add a job by link `job-link-intake` | button | pasted URL/text | passed_filters, then matcher→tailor→auditor server-side | 8/1 (7 applied) |
| 6 | Bulk links `ingest-links.yml` | dispatch | `worker/ingest/*.links.json` (≤40) | same as #5 | — |
| — | Email (gmail-sync, email-tracker-intake) | Apps Script + button | Gmail | tracks applications; not discovery | — |
| — | LinkedIn / social | none | enum value + badge only | not built | — |
| — | SmartRecruiters | off by robots ruling 11-01 | — | — | 0 since 10-30 (expected) |

Support jobs (not discovery): prescreen-drain (dispatch only, last ran 10-24), pregate-sweep (dispatch, idle 11 d),
postscreen-drain (DISABLED by Teja 2026-11-18 21:50; peer 1 re-scoping), jobs-tombstone (weekly), satellites (daily).

## Findings (status column is the work tracker)

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| D1 | HIGH | Workday discovery collapsed: robots.txt fetch returns 429 → gate fails closed → board counted failing | scout log 11-18 07:35Z: 43× `robots.txt gate refused … returned 429 with no readable Retry-After`, 8× HTTP 404; 63/64 failing | open, next free peer → **2026-11-23 re-measure: code DONE (eb56d28e, 3951ba06); OUTCOME OPEN, needs Teja: 58/64 Workday boards deferred on robots 429 (11-23, home IP too)** |
| D2 | HIGH | Held `discovered` rows have no automatic path forward (only normalizer reads them; manual drain only) | screen-batch.ts:120-121, 231-245; normalizer/index.ts:187 | peer 1 r2 (no-JD rows → passed_filters) → **2026-11-23 re-measure: DONE fa315449 + jd-refetch 4dc2adcc; 0 discovered rows (2026-11-23)** |
| D3 | HIGH | Workday description filled for NEW rows only, max 40/run; 515/587 Workday jobs since 11-12 lack text | persist-jobs.ts:120-126, workday-detail.ts:39 | open (pairs with D1) → **2026-11-23 re-measure: OPEN-no-Teja (blocked by D1): backfill 5 selected, 0 written; 63/68 new Workday rows NULL JD on 11-23** |
| D4 | HIGH | Scheduled scout has no queue/feed liveness; dead postings in the queue retire only on a button Scan | worker/src/cli/scout.ts vs scout-ats/index.ts:849-887 | open (pending #4) → **2026-11-23 re-measure: DONE 415881ec (liveness daily, green 11-19..23)** |
| D5 | MED | Scout logic written twice (worker + edge) and drifted | scout.ts:425-445 vs scout-ats/index.ts:630-652 | open → **2026-11-23 re-measure: PART converged (3951ba06, 8a99dbe6); peer 4 r2 owns the rest** |
| D6 | MED | scout-remote red 3 runs: ATS-twin lookup truncated at PostgREST 1000-row cap → dedupe misses | agent_runs `ats twin lookup truncated (1000 of 2134)` | open → **2026-11-23 re-measure: DONE 415881ec (keyset twin pages; no truncation since 11-18)** |
| D7 | MED | `includes('intern')` types "Internal"/"International" titles as internship → silent drop | remote-feeds.ts:295 (verified) | open → **2026-11-23 re-measure: DONE 415881ec (remote-feeds.ts:306)** |
| D8 | MED | Jobicy keeps the short excerpt, drops full description | remote-feeds.ts:256 (verified) | open → **2026-11-23 re-measure: DONE 415881ec (remote-feeds.ts:258)** |
| D9 | MED | Lever drops requirement bullets (lists[], additional) | _shared/ats/lever.ts ~150 | peer 2 r2 → **2026-11-23 re-measure: DONE fa315449 (lever.ts:88-106)** |
| D10 | MED | scout.yml hits 12-min budget every run (250/282 boards) | scout log | open → **2026-11-23 re-measure: DONE 4dc2adcc (16-min budget; runs 12-17 min, at the edge)** |
| D11 | MED | 10 dead boards still enabled (≥29 failures): GH atlassian, clevertap, yugabyte, postman, browserstack; Lever apna, swiggy, rippling, walmart; Ashby confluent | company_watchlist | open (orch SQL) → **2026-11-23 re-measure: DONE live (9 boards disabled; 0 enabled with >=29 failures). New: greenhouse:rothesaygraduates at 10** |
| D12 | MED | Retitled copy of an applied job re-enters the queue (Canonical 5150422) | 8e9d58ce applied + 111d1ff4 awaiting | peer 3 (already_applied by ATS id) → **2026-11-23 re-measure: DONE fa315449 + W2 07067197 + 953eb770 guard** |
| D13 | LOW | detectAtsProvider substring-matches the whole URL; still emits smartrecruiters | remote-feeds.ts:277-286 | open → **2026-11-23 re-measure: DONE 415881ec (hostname match)** |
| D14 | LOW | Dead code: adzuna.ts, jooble.ts (0 imports), tiers.ts, freshness.ts; workable registered-off | _shared/scout/adapters/ | open → **2026-11-23 re-measure: DONE 415881ec (files gone)** |
| D15 | LOW | Stale comments: scout.yml:6-7, scout-remote.yml:6, prescreen-drain.yml:4 | — | open → **2026-11-23 re-measure: DONE 170bd0e5** |
| D16 | LOW | Every scout run warns empty location_allowlist / title_blocklist | scout log | unverified: config or intended → **2026-11-23 re-measure: DONE live 2026-11-21 (rules disabled)** |
